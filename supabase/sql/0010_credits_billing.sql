-- Migration 0010 — Pricing, credits & billing
-- =============================================================================
-- This project's Supabase is BYO (the user owns it), so migrations are applied
-- manually. Apply this SQL via the Supabase SQL editor or by pasting into
-- src/lib/_oneshot/migration-sql.ts and hitting /api/public/admin-run-migration.
-- Idempotent — safe to re-run.
--
-- Adds:
--   * plans                 (catalog: free, basic, pro, team, enterprise)
--   * user_credits          (per-user wallet)
--   * credits_ledger        (append-only audit log; source of truth)
--   * plan_access_requests  (Pro/Team/Enterprise wait-list)
--   * RPCs: credits_get_state, credits_deduct, credits_refund,
--           credits_grant_monthly, credits_run_monthly_resets,
--           credits_set_plan, credits_summary
--   * RLS: read-only for users; writes via SECURITY DEFINER RPCs only.
-- =============================================================================
set search_path = public;

-- ---------------------------------------------------------------------------
-- 1. plans (catalog)
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id                text primary key,
  display_name      text not null,
  monthly_price_usd numeric(10,2) not null default 0,
  monthly_credits   integer not null default 0,
  features          jsonb not null default '{}'::jsonb,
  is_public         boolean not null default true,
  is_purchasable    boolean not null default false,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now()
);

insert into public.plans (id, display_name, monthly_price_usd, monthly_credits, features, is_purchasable, sort_order)
values
  ('free',       'Free',       0,   500,
    '{"models":["gpt-4o-mini","claude-haiku-4-5-20251001"],"memory":false,"documents":false,"max_context_tokens":10000,"advanced_routing":false}'::jsonb,
    true,  10),
  ('basic',      'Basic',      20,  5000,
    '{"models":["gpt-4o-mini","claude-haiku-4-5-20251001","gpt-4o","claude-sonnet-4-6","gemini-2.0-flash"],"memory":true,"documents":true,"max_context_tokens":50000,"advanced_routing":true}'::jsonb,
    true,  20),
  ('pro',        'Pro',        50,  20000,
    '{"models":["*"],"memory":true,"documents":true,"max_context_tokens":200000,"advanced_routing":true,"priority_support":true}'::jsonb,
    false, 30),
  ('team',       'Team',       150, 75000,
    '{"models":["*"],"memory":true,"documents":true,"max_context_tokens":200000,"advanced_routing":true,"shared_workspace":true}'::jsonb,
    false, 40),
  ('enterprise', 'Enterprise', 0,   0,
    '{"models":["*"],"memory":true,"documents":true,"sso":true,"custom":true}'::jsonb,
    false, 50)
on conflict (id) do update
  set display_name      = excluded.display_name,
      monthly_price_usd = excluded.monthly_price_usd,
      monthly_credits   = excluded.monthly_credits,
      features          = excluded.features,
      is_purchasable    = excluded.is_purchasable,
      sort_order        = excluded.sort_order;

alter table public.plans enable row level security;
drop policy if exists "plans readable by authenticated" on public.plans;
create policy "plans readable by authenticated"
  on public.plans for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. user_credits (wallet)
-- ---------------------------------------------------------------------------
create table if not exists public.user_credits (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  plan                   text not null default 'free' references public.plans(id),
  balance                integer not null default 0 check (balance >= 0),
  monthly_quota          integer not null default 500,
  last_reset_at          timestamptz not null default now(),
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    text,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

create index if not exists idx_user_credits_plan            on public.user_credits(plan);
create index if not exists idx_user_credits_stripe_customer on public.user_credits(stripe_customer_id);

alter table public.user_credits enable row level security;
drop policy if exists "user_credits self read" on public.user_credits;
create policy "user_credits self read"
  on public.user_credits for select to authenticated
  using (user_id = auth.uid());

-- Auto-provision wallet on user creation
create or replace function public.ensure_user_credits()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_quota integer;
begin
  select monthly_credits into v_quota from public.plans where id = coalesce(new.plan, 'free');
  insert into public.user_credits (user_id, plan, balance, monthly_quota, last_reset_at)
  values (new.id, coalesce(new.plan, 'free'), coalesce(v_quota, 500), coalesce(v_quota, 500), now())
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_ensure_user_credits on public.users;
create trigger trg_ensure_user_credits
  after insert on public.users
  for each row execute function public.ensure_user_credits();

-- Backfill
insert into public.user_credits (user_id, plan, balance, monthly_quota, last_reset_at)
select u.id, coalesce(u.plan, 'free'),
       coalesce(p.monthly_credits, 500), coalesce(p.monthly_credits, 500), now()
from public.users u
left join public.plans p on p.id = coalesce(u.plan, 'free')
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. credits_ledger
-- ---------------------------------------------------------------------------
create table if not exists public.credits_ledger (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  delta         integer not null,
  reason        text not null,
  balance_after integer not null,
  request_id    text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_credits_ledger_user_created on public.credits_ledger(user_id, created_at desc);
create index if not exists idx_credits_ledger_reason       on public.credits_ledger(reason);
create unique index if not exists uniq_credits_ledger_request_id
  on public.credits_ledger(user_id, request_id) where request_id is not null;

alter table public.credits_ledger enable row level security;
drop policy if exists "credits_ledger self read" on public.credits_ledger;
create policy "credits_ledger self read"
  on public.credits_ledger for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. plan_access_requests
-- ---------------------------------------------------------------------------
create table if not exists public.plan_access_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  plan       text not null references public.plans(id),
  message    text,
  status     text not null default 'pending' check (status in ('pending','contacted','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists idx_plan_access_requests_user on public.plan_access_requests(user_id);

alter table public.plan_access_requests enable row level security;
drop policy if exists "plan_access self read"   on public.plan_access_requests;
drop policy if exists "plan_access self insert" on public.plan_access_requests;
create policy "plan_access self read"
  on public.plan_access_requests for select to authenticated using (user_id = auth.uid());
create policy "plan_access self insert"
  on public.plan_access_requests for insert to authenticated
  with check (user_id = auth.uid() and plan in ('pro','team','enterprise'));

-- ===========================================================================
-- RPCs
-- ===========================================================================

create or replace function public.credits_get_state(p_user_id uuid default auth.uid())
returns table (user_id uuid, plan text, balance integer, monthly_quota integer,
               last_reset_at timestamptz, features jsonb,
               current_period_end timestamptz, subscription_status text)
language sql stable security definer set search_path = public as $$
  select uc.user_id, uc.plan, uc.balance, uc.monthly_quota, uc.last_reset_at,
         p.features, uc.current_period_end, uc.subscription_status
  from public.user_credits uc join public.plans p on p.id = uc.plan
  where uc.user_id = coalesce(p_user_id, auth.uid())
$$;

create or replace function public.credits_deduct(
  p_user_id uuid, p_amount integer, p_reason text,
  p_request_id text default null, p_metadata jsonb default '{}'::jsonb
) returns table (ledger_id uuid, balance_after integer, charged integer)
language plpgsql security definer set search_path = public as $$
declare v_existing public.credits_ledger%rowtype; v_new_balance integer; v_ledger_id uuid;
begin
  if p_amount <= 0 then raise exception 'invalid_amount'; end if;

  if p_request_id is not null then
    select * into v_existing from public.credits_ledger
      where user_id = p_user_id and request_id = p_request_id limit 1;
    if found then
      return query select v_existing.id, v_existing.balance_after, (-v_existing.delta)::integer;
      return;
    end if;
  end if;

  update public.user_credits
     set balance = balance - p_amount, updated_at = now()
   where user_id = p_user_id and balance >= p_amount
  returning balance into v_new_balance;

  if not found then raise exception 'insufficient_credits' using errcode = 'P0001'; end if;

  if v_new_balance <= 0 then
    perform public.apply_pending_plan(p_user_id);
    select balance into v_new_balance from public.user_credits where user_id = p_user_id;
  end if;

  insert into public.credits_ledger (user_id, delta, reason, balance_after, request_id, metadata)
  values (p_user_id, -p_amount, p_reason, v_new_balance, p_request_id, coalesce(p_metadata,'{}'::jsonb))
  returning id into v_ledger_id;

  return query select v_ledger_id, v_new_balance, p_amount;
end;
$$;

create or replace function public.credits_refund(
  p_user_id uuid, p_amount integer, p_reason text,
  p_request_id text default null, p_metadata jsonb default '{}'::jsonb
) returns table (ledger_id uuid, balance_after integer)
language plpgsql security definer set search_path = public as $$
declare v_new_balance integer; v_ledger_id uuid;
begin
  if p_amount <= 0 then raise exception 'invalid_amount'; end if;
  update public.user_credits set balance = balance + p_amount, updated_at = now()
   where user_id = p_user_id returning balance into v_new_balance;
  if not found then raise exception 'wallet_not_found'; end if;
  insert into public.credits_ledger (user_id, delta, reason, balance_after, request_id, metadata)
  values (p_user_id, p_amount, p_reason, v_new_balance, p_request_id, coalesce(p_metadata,'{}'::jsonb))
  returning id into v_ledger_id;
  return query select v_ledger_id, v_new_balance;
end;
$$;

create or replace function public.credits_grant_monthly(p_user_id uuid)
returns table (granted integer, balance_after integer)
language plpgsql security definer set search_path = public as $$
declare v_quota integer; v_balance integer; v_last_reset timestamptz; v_grant integer;
begin
  select monthly_quota, balance, last_reset_at into v_quota, v_balance, v_last_reset
  from public.user_credits where user_id = p_user_id for update;
  if not found then raise exception 'wallet_not_found'; end if;
  if v_last_reset > now() - interval '30 days' then
    return query select 0, v_balance; return;
  end if;
  v_grant := greatest(0, v_quota - v_balance);
  update public.user_credits set balance = v_quota, last_reset_at = now(), updated_at = now()
   where user_id = p_user_id;
  if v_grant > 0 then
    insert into public.credits_ledger (user_id, delta, reason, balance_after, metadata)
    values (p_user_id, v_grant, 'monthly_reset', v_quota,
            jsonb_build_object('previous_balance', v_balance, 'quota', v_quota));
  end if;
  return query select v_grant, v_quota;
end;
$$;

create or replace function public.credits_run_monthly_resets()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer := 0; r record;
begin
  for r in select user_id from public.user_credits
            where last_reset_at <= now() - interval '30 days' limit 5000 loop
    perform public.credits_grant_monthly(r.user_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.credits_set_plan(
  p_user_id uuid, p_plan text,
  p_stripe_customer_id text default null, p_stripe_subscription_id text default null,
  p_subscription_status text default null, p_current_period_end timestamptz default null
) returns table (plan text, balance_after integer)
language plpgsql security definer set search_path = public as $$
declare v_quota integer; v_old_plan text; v_balance integer;
begin
  select monthly_credits into v_quota from public.plans where id = p_plan;
  if not found then raise exception 'unknown_plan'; end if;
  select plan into v_old_plan from public.user_credits where user_id = p_user_id for update;

  update public.user_credits
     set plan = p_plan, monthly_quota = v_quota,
         balance = case
           when p_plan = v_old_plan then balance
           when v_quota > monthly_quota then v_quota
           else least(balance, v_quota)
         end,
         last_reset_at = case when p_plan = v_old_plan then last_reset_at else now() end,
         stripe_customer_id     = coalesce(p_stripe_customer_id, stripe_customer_id),
         stripe_subscription_id = coalesce(p_stripe_subscription_id, stripe_subscription_id),
         subscription_status    = coalesce(p_subscription_status, subscription_status),
         current_period_end     = coalesce(p_current_period_end, current_period_end),
         updated_at = now()
   where user_id = p_user_id returning balance into v_balance;

  if not found then
    insert into public.user_credits (user_id, plan, balance, monthly_quota, last_reset_at,
      stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end)
    values (p_user_id, p_plan, v_quota, v_quota, now(),
      p_stripe_customer_id, p_stripe_subscription_id, p_subscription_status, p_current_period_end)
    returning balance into v_balance;
  end if;

  update public.users set plan = p_plan where id = p_user_id;

  if v_old_plan is distinct from p_plan then
    insert into public.credits_ledger (user_id, delta, reason, balance_after, metadata)
    values (p_user_id, 0, 'plan_change', v_balance,
            jsonb_build_object('from', v_old_plan, 'to', p_plan));
  end if;
  return query select p_plan, v_balance;
end;
$$;

create or replace function public.credits_summary(p_user_id uuid default auth.uid())
returns table (reason text, total_spent integer, request_count bigint)
language sql stable security definer set search_path = public as $$
  select reason, (-sum(delta))::integer, count(*)
    from public.credits_ledger
   where user_id = coalesce(p_user_id, auth.uid()) and delta < 0
     and created_at >= now() - interval '30 days'
   group by reason
$$;

grant execute on function public.credits_get_state(uuid)                        to authenticated;
grant execute on function public.credits_summary(uuid)                          to authenticated;
grant execute on function public.credits_deduct(uuid,integer,text,text,jsonb)   to authenticated;
grant execute on function public.credits_refund(uuid,integer,text,text,jsonb)   to authenticated;
grant execute on function public.credits_grant_monthly(uuid)                    to authenticated;
grant execute on function public.credits_set_plan(uuid,text,text,text,text,timestamptz) to service_role;
grant execute on function public.credits_run_monthly_resets()                   to service_role;
