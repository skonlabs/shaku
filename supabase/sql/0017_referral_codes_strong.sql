-- Migration 0017 — Stronger, cryptographically-random referral codes
-- =============================================================================
-- Replaces gen_referral_code() to use pgcrypto's gen_random_bytes() (CSPRNG)
-- instead of random(), and lengthens codes from 8 → 12 chars over a 32-char
-- ambiguity-free alphabet. Search space: 32^12 ≈ 1.15 × 10^18 (vs 32^8 ≈ 1.1e12).
-- Keeps unique constraint on referral_codes.code.
--
-- Idempotent. Apply via Supabase SQL editor.
-- =============================================================================
set search_path = public;

create extension if not exists pgcrypto;

create or replace function public.gen_referral_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 chars, no I/O/0/1
  v_len      int  := 12;
  v_code     text := '';
  v_bytes    bytea;
  v_i        int;
begin
  -- Cryptographically-strong randomness from pgcrypto
  v_bytes := gen_random_bytes(v_len);
  for v_i in 0..(v_len - 1) loop
    -- mask to 5 bits → 0..31, index into 32-char alphabet
    v_code := v_code || substr(
      v_alphabet,
      1 + (get_byte(v_bytes, v_i) & 31),
      1
    );
  end loop;
  return v_code;
end;
$$;
