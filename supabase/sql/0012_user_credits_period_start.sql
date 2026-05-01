-- Migration 0012 — Add current_period_start to user_credits
-- Idempotent. The billing code writes both current_period_start and
-- current_period_end when syncing Stripe subscriptions.
set search_path = public;

alter table public.user_credits
  add column if not exists current_period_start timestamptz;
