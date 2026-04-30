-- Migration 0011 — Billing extensions
-- =============================================================================
-- Apply via Supabase SQL editor. Idempotent.
--
-- Adds:
--   * stripe_events            — idempotency log for Stripe webhook events
--   * credits_grant_for_period — atomic plan-flip + monthly grant for a billing
--                                period, idempotent on (user_id, period_start)
-- =============================================================================
set search_path = public;

-- ---------------------------------------------------------------------------
-- 1. stripe_events (idempotency)
-- ---------------------------------------------------------------------------
create table if not exists public.stripe_events (
  event_id     text primary key,
  type         text not null,
  payload      jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
-- No policies — service role only.

-- ---------------------------------------------------------------------------
-- 2. credits_grant_for_period
-- ---------------------------------------------------------------------------
-- Sets the user's plan and grants the plan's monthly credits for a specific
-- billing period. Idempotent on (user_id, period_start) via ledger metadata
-- so replayed Stripe events never double-grant.
--
-- Returns: granted (credits added this call), balance_after.
--
create or replace function public.credits_grant_for_period(
  p_user_id                uuid,
  p_plan                   text,
  p_period_start           timestamptz,
  p_period_end             timestamptz,
  p_stripe_customer_id     text default null,
  p_stripe_subscription_id text default null,
  p_subscription_status    text default null
) returns table (granted integer, balance_after integer, already_granted boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_quota          integer;
  v_balance        integer;
  v_old_plan       text;
  v_already        boolean := false;
  v_period_key     text := to_char(p_period_start at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if p_user_id is null then raise exception 'user_id_required'; end if;

  select monthly_credits into v_quota from public.plans where id = p_plan;
  if not found then raise exception 'unknown_plan'; end if;

  -- Idempotency: already granted for this period?
  select true into v_already
  from public.credits_ledger
  where user_id = p_user_id
    and reason  = 'plan_grant'
    and metadata->>'period_start' = v_period_key
  limit 1;

  if v_already then
    select balance into v_balance from public.user_credits where user_id = p_user_id;
    return query select 0, coalesce(v_balance, 0), true;
    return;
  end if;

  -- Lock the wallet row (or create it).
  select plan, balance into v_old_plan, v_balance
  from public.user_credits where user_id = p_user_id for update;

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
           balance = v_quota,            -- replace, not add — period is new
           last_reset_at = p_period_start,
           stripe_customer_id     = coalesce(p_stripe_customer_id, stripe_customer_id),
           stripe_subscription_id = coalesce(p_stripe_subscription_id, stripe_subscription_id),
           subscription_status    = coalesce(p_subscription_status, subscription_status),
           current_period_end     = coalesce(p_period_end, current_period_end),
           updated_at = now()
     where user_id = p_user_id;
    v_balance := v_quota;
  end if;

  update public.users set plan = p_plan where id = p_user_id;

  insert into public.credits_ledger (user_id, delta, reason, balance_after, request_id, metadata)
  values (
    p_user_id, v_quota, 'plan_grant', v_balance,
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

grant execute on function public.credits_grant_for_period(
  uuid, text, timestamptz, timestamptz, text, text, text
) to service_role;
