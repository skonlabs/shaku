-- Scheduled plan changes.
-- Downgrades and upgrades don't apply immediately — they apply when the
-- current plan's credits are used up OR the current billing period ends,
-- whichever comes first. No refunds, no balance wipes.

alter table public.user_credits
  add column if not exists pending_plan text references public.plans(id),
  add column if not exists pending_plan_effective_at timestamptz;

create index if not exists idx_user_credits_pending_plan_effective
  on public.user_credits(pending_plan_effective_at)
  where pending_plan is not null;

-- Apply a pending plan change for a single user if eligible (balance == 0 OR
-- effective date has passed). Idempotent. Safe to call from server functions.
create or replace function public.apply_pending_plan(p_user_id uuid)
returns table(plan text, applied boolean) language plpgsql security definer set search_path = public as $$
declare
  v_pending text;
  v_effective timestamptz;
  v_balance integer;
  v_quota integer;
  v_period_end timestamptz;
  v_current_plan text;
begin
  select uc.pending_plan, uc.pending_plan_effective_at, uc.balance, uc.current_period_end, uc.plan
    into v_pending, v_effective, v_balance, v_period_end, v_current_plan
  from public.user_credits uc where uc.user_id = p_user_id for update;

  if v_pending is null then
    return query select v_current_plan, false; return;
  end if;

  -- Eligibility: balance exhausted, or effective date passed.
  if not (v_balance <= 0 or (v_effective is not null and v_effective <= now())) then
    return query select v_current_plan, false; return;
  end if;

  select monthly_credits into v_quota from public.plans where id = v_pending;
  if v_quota is null then v_quota := 500; end if;

  update public.user_credits
     set plan = v_pending,
         pending_plan = null,
         pending_plan_effective_at = null,
         monthly_quota = v_quota,
         -- Reset balance to new plan's quota when the change actually applies.
         balance = v_quota,
         last_reset_at = now(),
         updated_at = now()
   where user_id = p_user_id;

  insert into public.credit_ledger (user_id, delta, balance_after, reason, metadata)
  values (p_user_id, v_quota - v_balance, v_quota, 'plan_change',
          jsonb_build_object('to_plan', v_pending, 'from_plan', v_current_plan, 'source', 'scheduled_apply'));

  return query select v_pending, true;
end;
$$;

grant execute on function public.apply_pending_plan(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
