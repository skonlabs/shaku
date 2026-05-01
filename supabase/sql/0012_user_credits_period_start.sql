-- Migration 0012 — Optional legacy period-start column
-- Idempotent. The app no longer requires this column; keep this only for
-- environments where older deployed code already referenced it.
set search_path = public;

alter table public.user_credits
  add column if not exists current_period_start timestamptz;
