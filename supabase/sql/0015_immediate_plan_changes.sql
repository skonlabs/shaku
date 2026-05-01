-- Migration 0015 — Immediate plan changes with preserved credits/expiry.
-- =============================================================================
-- Upgrade/downgrade display plan must change immediately, but the user keeps
-- their current credit balance and current_period_end. This function is the
-- single authoritative write path used by the app and webhooks.
-- =============================================================================
set search_path = public;

create or replace function public.credits_change_plan_immediate(
  p_user_id uuid,
  p_target_plan text
) returns table (plan text, balance_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quota integer;
  v_old_plan text;
  v_balance integer;
begin
  if p_user_id is null then
    raise exception 'user_id_required';
  end if;

  if auth.role() <> 'service_role' and p_user_id is distinct from auth.uid() then
    raise exception 'not_allowed';
  end if;

  select monthly_credits into v_quota from public.plans where id = p_target_plan;
  if not found then
    raise exception 'unknown_plan';
  end if;

  select uc.plan, uc.balance
    into v_old_plan, v_balance
  from public.user_credits uc
  where uc.user_id = p_user_id
  for update;

  if not found then
    insert into public.user_credits (
      user_id, plan, balance, monthly_quota, last_reset_at,
      pending_plan, pending_plan_effective_at
    ) values (
      p_user_id, p_target_plan, v_quota, v_quota, now(), null, null
    )
    returning balance into v_balance;
  else
    update public.user_credits
       set plan = p_target_plan,
           monthly_quota = v_quota,
           pending_plan = null,
           pending_plan_effective_at = null,
           updated_at = now()
     where user_id = p_user_id
     returning balance into v_balance;
  end if;

  update public.users set plan = p_target_plan where id = p_user_id;

  if v_old_plan is distinct from p_target_plan then
    insert into public.credits_ledger (user_id, delta, reason, balance_after, metadata)
    values (
      p_user_id,
      0,
      'plan_change',
      v_balance,
      jsonb_build_object(
        'from_plan', v_old_plan,
        'to_plan', p_target_plan,
        'source', 'immediate',
        'balance_preserved', v_balance
      )
    );
  end if;

  return query select p_target_plan, v_balance;
end;
$$;

grant execute on function public.credits_change_plan_immediate(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';