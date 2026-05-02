-- Migration 0014 — Make scheduled plan changes authoritative.
-- =============================================================================
-- A scheduled plan change is not just a UI state. When it becomes eligible
-- (credits reach 0 OR the effective date has passed), it must update both:
--   * public.user_credits.plan — billing wallet source of truth
--   * public.users.plan        — app/chat/rate-limit plan reads
-- It must also not be undone by late Stripe subscription webhooks.
-- =============================================================================
set search_path = public;

alter table public.user_credits
  add column if not exists pending_plan text references public.plans(id),
  add column if not exists pending_plan_effective_at timestamptz;

create index if not exists idx_user_credits_pending_plan_effective
  on public.user_credits(pending_plan_effective_at)
  where pending_plan is not null;

create or replace function public.apply_pending_plan(p_user_id uuid)
returns table(plan text, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending text;
  v_effective timestamptz;
  v_balance integer;
  v_quota integer;
  v_current_plan text;
begin
  select uc.pending_plan, uc.pending_plan_effective_at, uc.balance, uc.plan
    into v_pending, v_effective, v_balance, v_current_plan
  from public.user_credits uc
  where uc.user_id = p_user_id
  for update;

  if not found then
    return query select 'free'::text, false;
    return;
  end if;

  if v_pending is null then
    return query select v_current_plan, false;
    return;
  end if;

  if not (v_balance <= 0 or (v_effective is not null and v_effective <= now())) then
    return query select v_current_plan, false;
    return;
  end if;

  select monthly_credits into v_quota from public.plans where id = v_pending;
  if v_quota is null then
    v_quota := 500;
  end if;

  update public.user_credits
     set plan = v_pending,
         pending_plan = null,
         pending_plan_effective_at = null,
         monthly_quota = v_quota,
         balance = v_quota,
         last_reset_at = case when v_balance <= 0 then last_reset_at else now() end,
         updated_at = now()
   where user_id = p_user_id;

  update public.users
     set plan = v_pending
   where id = p_user_id;

  insert into public.credits_ledger (user_id, delta, balance_after, reason, metadata)
  values (
    p_user_id,
    v_quota - v_balance,
    v_quota,
    'plan_change',
    jsonb_build_object(
      'from_plan', v_current_plan,
      'to_plan', v_pending,
      'source', 'scheduled_apply',
      'triggered_by_balance_exhausted', v_balance <= 0,
      'effective_at', v_effective
    )
  );

  return query select v_pending, true;
end;
$$;

grant execute on function public.apply_pending_plan(uuid) to authenticated, service_role;

create or replace function public.credits_deduct(
  p_user_id uuid,
  p_amount integer,
  p_reason text,
  p_request_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns table (ledger_id uuid, balance_after integer, charged integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.credits_ledger%rowtype;
  v_new_balance integer;
  v_ledger_id uuid;
begin
  if p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  if p_request_id is not null then
    select * into v_existing
    from public.credits_ledger
    where user_id = p_user_id and request_id = p_request_id
    limit 1;

    if found then
      return query select v_existing.id, v_existing.balance_after, (-v_existing.delta)::integer;
      return;
    end if;
  end if;

  update public.user_credits
     set balance = balance - p_amount,
         updated_at = now()
   where user_id = p_user_id and balance >= p_amount
   returning balance into v_new_balance;

  if not found then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  insert into public.credits_ledger (user_id, delta, reason, balance_after, request_id, metadata)
  values (p_user_id, -p_amount, p_reason, v_new_balance, p_request_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_ledger_id;

  if v_new_balance <= 0 then
    perform public.apply_pending_plan(p_user_id);
    select balance into v_new_balance from public.user_credits where user_id = p_user_id;
  end if;

  return query select v_ledger_id, v_new_balance, p_amount;
end;
$$;

create or replace function public.credits_grant_for_period(
  p_user_id                uuid,
  p_plan                   text,
  p_period_start           timestamptz,
  p_period_end             timestamptz,
  p_stripe_customer_id     text default null,
  p_stripe_subscription_id text default null,
  p_subscription_status    text default null
) returns table (granted integer, balance_after integer, already_granted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quota integer;
  v_balance integer;
  v_old_plan text;
  v_already boolean := false;
  v_period_key text := to_char(p_period_start at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if p_user_id is null then
    raise exception 'user_id_required';
  end if;

  select monthly_credits into v_quota from public.plans where id = p_plan;
  if not found then
    raise exception 'unknown_plan';
  end if;

  select true into v_already
  from public.credits_ledger
  where user_id = p_user_id
    and reason = 'plan_grant'
    and metadata->>'period_start' = v_period_key
  limit 1;

  if v_already then
    select balance into v_balance from public.user_credits where user_id = p_user_id;
    return query select 0, coalesce(v_balance, 0), true;
    return;
  end if;

  update public.user_credits
     set current_period_end = p_period_end,
         subscription_status = coalesce(p_subscription_status, subscription_status),
         stripe_customer_id = coalesce(p_stripe_customer_id, stripe_customer_id),
         stripe_subscription_id = coalesce(p_stripe_subscription_id, stripe_subscription_id),
         updated_at = now()
   where user_id = p_user_id
     and pending_plan is not null
     and pending_plan <> p_plan
     and pending_plan_effective_at is not null
     and pending_plan_effective_at <= now();

  if found then
    perform public.apply_pending_plan(p_user_id);
    select balance into v_balance from public.user_credits where user_id = p_user_id;
    return query select 0, coalesce(v_balance, 0), false;
    return;
  end if;

  select plan, balance into v_old_plan, v_balance
  from public.user_credits
  where user_id = p_user_id
  for update;

  if not found then
    insert into public.user_credits (
      user_id, plan, balance, monthly_quota, last_reset_at,
      stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end
    ) values (
      p_user_id, p_plan, v_quota, v_quota, p_period_start,
      p_stripe_customer_id, p_stripe_subscription_id, p_subscription_status, p_period_end
    );
    v_balance := v_quota;
    v_old_plan := null;
  else
    update public.user_credits
       set plan = p_plan,
           monthly_quota = v_quota,
           balance = v_quota,
           last_reset_at = p_period_start,
           pending_plan = null,
           pending_plan_effective_at = null,
           stripe_customer_id = coalesce(p_stripe_customer_id, stripe_customer_id),
           stripe_subscription_id = coalesce(p_stripe_subscription_id, stripe_subscription_id),
           subscription_status = coalesce(p_subscription_status, subscription_status),
           current_period_end = coalesce(p_period_end, current_period_end),
           updated_at = now()
     where user_id = p_user_id;
    v_balance := v_quota;
  end if;

  update public.users set plan = p_plan where id = p_user_id;

  insert into public.credits_ledger (user_id, delta, reason, balance_after, request_id, metadata)
  values (
    p_user_id,
    v_quota,
    'plan_grant',
    v_balance,
    'stripe:' || coalesce(p_stripe_subscription_id, 'manual') || ':' || v_period_key,
    jsonb_build_object(
      'plan', p_plan,
      'previous_plan', v_old_plan,
      'period_start', v_period_key,
      'period_end', to_char(p_period_end at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'stripe_subscription_id', p_stripe_subscription_id,
      'stripe_customer_id', p_stripe_customer_id
    )
  )
  on conflict (user_id, request_id) where request_id is not null do nothing;

  return query select v_quota, v_balance, false;
end;
$$;

grant execute on function public.credits_get_state(uuid) to authenticated;
grant execute on function public.credits_deduct(uuid, integer, text, text, jsonb) to authenticated;
grant execute on function public.credits_grant_for_period(uuid, text, timestamptz, timestamptz, text, text, text) to service_role;

notify pgrst, 'reload schema';
