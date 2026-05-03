-- Migration 0016 — Invite-only signup via referral codes
-- =============================================================================
-- This project's Supabase is BYO (the user owns it), so migrations are applied
-- manually. Apply this SQL via the Supabase SQL editor.
-- Idempotent — safe to re-run.
--
-- Adds:
--   * referral_codes        (each code single-use; owner has 2 per month)
--   * RPCs: gen_referral_code, issue_monthly_referral_codes,
--           is_referral_code_valid, signup_requires_referral
--   * Replaces handle_new_user to enforce referral gate after first 25 signups,
--     redeem code, and issue 2 codes for the new user.
-- =============================================================================
set search_path = public;

create table if not exists public.referral_codes (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  period_start    date not null,
  status          text not null default 'unused' check (status in ('unused','used')),
  used_by_user_id uuid references auth.users(id) on delete set null,
  used_at         timestamptz,
  created_at      timestamptz not null default timezone('utc', now())
);

create index if not exists referral_codes_owner_period_idx
  on public.referral_codes (owner_id, period_start);
create index if not exists referral_codes_code_idx
  on public.referral_codes (code);

alter table public.referral_codes enable row level security;

drop policy if exists "owner reads own codes" on public.referral_codes;
create policy "owner reads own codes" on public.referral_codes
  for select to authenticated
  using (owner_id = auth.uid());
-- writes only via SECURITY DEFINER functions below

create or replace function public.gen_referral_code()
returns text
language plpgsql
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code     text := '';
  v_i        int;
begin
  for v_i in 1..8 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_code;
end;
$$;

create or replace function public.issue_monthly_referral_codes(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('month', timezone('utc', now()))::date;
  v_count  int;
  v_code   text;
  v_try    int;
  v_ok     boolean;
begin
  select count(*) into v_count
    from public.referral_codes
   where owner_id = p_user_id and period_start = v_period;

  while v_count < 2 loop
    v_ok := false;
    v_try := 0;
    while not v_ok and v_try < 10 loop
      begin
        v_code := public.gen_referral_code();
        insert into public.referral_codes (code, owner_id, period_start)
        values (v_code, p_user_id, v_period);
        v_ok := true;
      exception when unique_violation then
        v_try := v_try + 1;
      end;
    end loop;
    v_count := v_count + 1;
  end loop;
end;
$$;

create or replace function public.is_referral_code_valid(p_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.referral_codes
     where code = upper(p_code) and status = 'unused'
  );
$$;
grant execute on function public.is_referral_code_valid(text) to anon, authenticated;

create or replace function public.signup_requires_referral()
returns boolean
language sql
security definer
set search_path = public
as $$
  select (select count(*) from public.users) >= 25;
$$;
grant execute on function public.signup_requires_referral() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- handle_new_user — gate signup, redeem code, issue codes for new user
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code           text;
  v_existing_count int;
  v_redeemed       int;
begin
  v_code := upper(coalesce(new.raw_user_meta_data ->> 'referral_code', ''));
  select count(*) into v_existing_count from public.users;

  if v_existing_count >= 25 then
    if v_code = '' then
      raise exception 'A referral code is required to sign up.' using errcode = 'P0001';
    end if;

    update public.referral_codes
       set status = 'used',
           used_by_user_id = new.id,
           used_at = timezone('utc', now())
     where code = v_code and status = 'unused';

    get diagnostics v_redeemed = row_count;
    if v_redeemed = 0 then
      raise exception 'That referral code is invalid or has already been used.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.users (id, email, name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(public.users.name, excluded.name),
        avatar_url = coalesce(public.users.avatar_url, excluded.avatar_url),
        updated_at = timezone('utc', now());

  perform public.issue_monthly_referral_codes(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Backfill: issue codes for existing users for the current month.
do $$
declare r record;
begin
  for r in select id from public.users loop
    perform public.issue_monthly_referral_codes(r.id);
  end loop;
end $$;
