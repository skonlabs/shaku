-- Migration: add missing columns and RLS policies discovered during CRUD audit

-- 1. connectors: add metadata JSONB for Slack team_id/team_name storage
ALTER TABLE public.connectors
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- 2. datasource_files: add error_message for recording processing failures
ALTER TABLE public.datasource_files
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 3. usage_events: add INSERT policy (previously only SELECT existed)
--    Allows authenticated users to insert their own usage events
CREATE POLICY IF NOT EXISTS "Own usage events (insert)" ON public.usage_events
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
