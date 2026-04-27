export const MIGRATION_SQL = `-- =============================================================================
-- Consolidated catch-up: applies migrations 0002..0009 in order.
-- Idempotent — safe to re-run. Paste into Supabase SQL editor and run.
-- =============================================================================

-- Required extensions (no-ops if already enabled)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;



-- ============================================================================
-- Drop existing overloads of all functions we're about to recreate.
-- This avoids "cannot change return type of existing function" errors
-- when re-running against a database that already has older signatures.
-- ============================================================================
DO \$drop_funcs\$
DECLARE
  fn_name TEXT;
  sig     TEXT;
BEGIN
  FOREACH fn_name IN ARRAY ARRAY[
    'increment_shared_view_count',
    'search_user_messages',
    'search_chunks',
    'search_memories',
    'insert_usage_event',
    'insert_audit_log',
    'increment_memory_access',
    'get_active_task',
    'upsert_task',
    'insert_context_log',
    'get_context_log'
  ] LOOP
    FOR sig IN
      SELECT pg_get_function_identity_arguments(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fn_name
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', fn_name, sig);
    END LOOP;
  END LOOP;
END
\$drop_funcs\$;

-- ========================================================================
-- supabase/migrations/0002_phase1_full_schema.sql
-- ========================================================================
-- ============================================================
-- Phase 1 Full Schema Migration
-- Run after 0001_sprint1_schema.sql
-- Requires: pgvector extension, pg_cron enabled in Supabase dashboard
-- ============================================================

-- ---- Extensions ----
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- Fix gaps in existing tables ----

-- users: add missing columns
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS analytics_opted_in BOOLEAN NOT NULL DEFAULT false;

-- users: pii_preferences needs proper default (update rows that have empty object)
UPDATE public.users
SET pii_preferences = '{
  "name": "always_ask",
  "email": "always_ask",
  "phone": "always_ask",
  "address": "always_ask",
  "ssn": "always_redact",
  "credit_card": "always_redact"
}'::jsonb
WHERE pii_preferences = '{}'::jsonb OR pii_preferences IS NULL;

-- users: unique constraint on email
DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_email_key'
  ) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_email_key UNIQUE (email);
  END IF;
END\$\$;

-- conversations: proper FK on project_id (will be added once projects table exists)
-- (Applied below after projects table creation)

-- messages: fix share_id to UUID type (migrate existing text values)
DO \$\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'share_id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE public.messages DROP COLUMN share_id;
    ALTER TABLE public.messages ADD COLUMN share_id UUID UNIQUE DEFAULT NULL;
  END IF;
END\$\$;

-- messages: tsvector for full-text search across message content
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search
  ON public.messages USING gin(search_vector)
  WHERE is_active = true;

-- conversations: tsvector on title for search
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_conversations_search
  ON public.conversations USING gin(search_vector);

-- ---- Projects ----
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#378ADD',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own projects" ON public.projects;
CREATE POLICY "Own projects" ON public.projects
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_projects_updated_at ON public.projects;
CREATE TRIGGER set_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Now add the FK on conversations.project_id
DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_project_id_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END\$\$;

-- ---- Shared Responses ----
CREATE TABLE IF NOT EXISTS public.shared_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_message_content TEXT NOT NULL,
  assistant_message_content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  view_count INT NOT NULL DEFAULT 0
);

ALTER TABLE public.shared_responses ENABLE ROW LEVEL SECURITY;

-- Public read: anyone (including unauthenticated) can view shared responses
DROP POLICY IF EXISTS "Public read shared responses" ON public.shared_responses;
CREATE POLICY "Public read shared responses" ON public.shared_responses
  FOR SELECT TO anon, authenticated USING (true);

-- Owner insert: only the owner can create shares
DROP POLICY IF EXISTS "Owner insert shared responses" ON public.shared_responses;
CREATE POLICY "Owner insert shared responses" ON public.shared_responses
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- Owner delete: only the owner can delete their shares
DROP POLICY IF EXISTS "Owner delete shared responses" ON public.shared_responses;
CREATE POLICY "Owner delete shared responses" ON public.shared_responses
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Atomic view count increment (avoids read-modify-write race, callable by anon)
CREATE OR REPLACE FUNCTION public.increment_shared_view_count(share_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = public AS \$\$
  UPDATE public.shared_responses SET view_count = view_count + 1 WHERE id = share_id;
\$\$;

GRANT EXECUTE ON FUNCTION public.increment_shared_view_count TO anon, authenticated;

-- ---- Conversation States ----
CREATE TABLE IF NOT EXISTS public.conversation_states (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  summary TEXT,
  summary_covers_until INT NOT NULL DEFAULT 0,
  conversation_facts JSONB NOT NULL DEFAULT '[]',
  active_topics TEXT[] NOT NULL DEFAULT '{}',
  style_profile JSONB NOT NULL DEFAULT '{}',
  conversation_tone JSONB NOT NULL DEFAULT '{"current":"casual","confidence":0.5,"signals":[]}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.conversation_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own conversation states" ON public.conversation_states;
CREATE POLICY "Own conversation states" ON public.conversation_states
  FOR ALL TO authenticated
  USING (
    conversation_id IN (
      SELECT id FROM public.conversations WHERE user_id = auth.uid()
    )
  );

-- ---- Memories ----
CREATE TABLE IF NOT EXISTS public.memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  -- type values: preference, semantic, episodic, behavioral, anti_preference, correction, response_style, project
  content TEXT NOT NULL,
  source_conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  confidence FLOAT NOT NULL DEFAULT 0.8,
  importance FLOAT NOT NULL DEFAULT 0.5,
  access_count INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  embedding VECTOR(1536),
  expires_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1,
  superseded_by UUID REFERENCES public.memories(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own memories" ON public.memories;
CREATE POLICY "Own memories" ON public.memories
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_memories_updated_at ON public.memories;
CREATE TRIGGER set_memories_updated_at
  BEFORE UPDATE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_memories_user_type
  ON public.memories (user_id, type)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON public.memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-text search on memories (needed by exhaustive-strategy L2 search)
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_search
  ON public.memories USING gin(search_vector)
  WHERE superseded_by IS NULL;

-- ---- User Knowledge Models ----
CREATE TABLE IF NOT EXISTS public.user_knowledge_models (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  identity JSONB NOT NULL DEFAULT '{}',
  active_projects JSONB NOT NULL DEFAULT '[]',
  relationships JSONB NOT NULL DEFAULT '[]',
  communication_style JSONB NOT NULL DEFAULT '{}',
  preferences JSONB NOT NULL DEFAULT '{}',
  anti_preferences JSONB NOT NULL DEFAULT '[]',
  corrections JSONB NOT NULL DEFAULT '[]',
  response_style_dislikes JSONB NOT NULL DEFAULT '[]',
  emotional_patterns JSONB NOT NULL DEFAULT '{}',
  source_trust JSONB NOT NULL DEFAULT '{}',
  opinions JSONB NOT NULL DEFAULT '[]',
  schedule JSONB NOT NULL DEFAULT '{}',
  expertise JSONB NOT NULL DEFAULT '[]',
  correction_count INT NOT NULL DEFAULT 0,
  last_pattern_analysis TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.user_knowledge_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own knowledge model" ON public.user_knowledge_models;
CREATE POLICY "Own knowledge model" ON public.user_knowledge_models
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_ukm_updated_at ON public.user_knowledge_models;
CREATE TRIGGER set_ukm_updated_at
  BEFORE UPDATE ON public.user_knowledge_models
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---- Datasource Folders ----
CREATE TABLE IF NOT EXISTS public.datasource_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.datasource_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.datasource_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own folders" ON public.datasource_folders;
CREATE POLICY "Own folders" ON public.datasource_folders
  FOR ALL TO authenticated USING (user_id = auth.uid());

-- ---- Datasource Files ----
CREATE TABLE IF NOT EXISTS public.datasource_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.datasource_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size_bytes BIGINT,
  storage_path TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  -- status values: uploading, processing, ready, error
  content_hash TEXT,
  last_refreshed_at TIMESTAMPTZ,
  chunk_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.datasource_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own datasource files" ON public.datasource_files;
CREATE POLICY "Own datasource files" ON public.datasource_files
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_datasource_files_updated_at ON public.datasource_files;
CREATE TRIGGER set_datasource_files_updated_at
  BEFORE UPDATE ON public.datasource_files
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---- Connectors ----
CREATE TABLE IF NOT EXISTS public.connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  -- status values: connected, syncing, paused, error, disconnected
  oauth_token_encrypted TEXT,
  oauth_refresh_token_encrypted TEXT,
  oauth_state TEXT, -- CSRF state token, cleared after use
  last_synced_at TIMESTAMPTZ,
  items_indexed INT NOT NULL DEFAULT 0,
  sync_cursor TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (user_id, service)
);

ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own connectors" ON public.connectors;
CREATE POLICY "Own connectors" ON public.connectors
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_connectors_updated_at ON public.connectors;
CREATE TRIGGER set_connectors_updated_at
  BEFORE UPDATE ON public.connectors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---- Chunks (from datasources and connectors) ----
CREATE TABLE IF NOT EXISTS public.chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  -- source_type values: datasource, connector, conversation_upload, url_in_message
  source_id UUID NOT NULL,
  source_item_id TEXT,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  content_hash TEXT,
  embedding VECTOR(1536),
  expires_at TIMESTAMPTZ, -- for conversation_upload (7 days), url_in_message (1 day)
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own chunks" ON public.chunks;
CREATE POLICY "Own chunks" ON public.chunks
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_chunks_updated_at ON public.chunks;
CREATE TRIGGER set_chunks_updated_at
  BEFORE UPDATE ON public.chunks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Full-text search on chunks
ALTER TABLE public.chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_search
  ON public.chunks USING gin(search_vector);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON public.chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_chunks_source
  ON public.chunks (user_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_chunks_expires
  ON public.chunks (expires_at)
  WHERE expires_at IS NOT NULL;

-- ---- Feedback Events ----
CREATE TABLE IF NOT EXISTS public.feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL,
  -- values: thumbs_up, thumbs_down, correction, rephrasing, regeneration, copy, action_approved
  reason TEXT,
  -- for thumbs_down: inaccurate, not_helpful, too_long, too_short, wrong_format, other
  free_text TEXT,
  mismatch_analysis JSONB,
  lesson_extracted TEXT,
  memory_created_id UUID REFERENCES public.memories(id),
  model_used TEXT,
  response_metadata JSONB,
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own feedback events" ON public.feedback_events;
CREATE POLICY "Own feedback events" ON public.feedback_events
  FOR ALL TO authenticated USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_feedback_user_processed
  ON public.feedback_events (user_id, processed, created_at DESC);

-- ---- Actions ----
CREATE TABLE IF NOT EXISTS public.actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id),
  message_id UUID REFERENCES public.messages(id),
  action_type TEXT NOT NULL,
  target_service TEXT NOT NULL,
  parameters JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  -- values: proposed, approved, executing, completed, failed, undone
  result JSONB,
  idempotency_key UUID NOT NULL DEFAULT gen_random_uuid(),
  undo_available_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own actions" ON public.actions;
CREATE POLICY "Own actions" ON public.actions
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_actions_updated_at ON public.actions;
CREATE TRIGGER set_actions_updated_at
  BEFORE UPDATE ON public.actions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---- Audit Logs (append-only, hash-chained) ----
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  action TEXT NOT NULL,
  -- values: request, retrieval, memory_read, memory_write, memory_delete,
  --         action_execute, action_undo, connector_connect, connector_disconnect, data_delete
  details JSONB NOT NULL,
  prev_hash TEXT,
  hash TEXT, -- SHA-256 of (id || user_id || action || details || prev_hash)
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own audit logs (read)" ON public.audit_logs;
CREATE POLICY "Own audit logs (read)" ON public.audit_logs
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Only service role can insert audit logs (enforced by not granting INSERT to authenticated)

CREATE INDEX IF NOT EXISTS idx_audit_logs_user
  ON public.audit_logs (user_id, created_at DESC);

-- ---- Usage Events ----
CREATE TABLE IF NOT EXISTS public.usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  model_used TEXT,
  tokens_in INT,
  tokens_out INT,
  cost_usd DECIMAL(10, 6),
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  routing_savings_usd DECIMAL(10, 6),
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own usage events (read)" ON public.usage_events;
CREATE POLICY "Own usage events (read)" ON public.usage_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_usage_events_user_date
  ON public.usage_events (user_id, created_at DESC);

-- ---- Proactive Triggers (schema only — engine in Phase 3) ----
CREATE TABLE IF NOT EXISTS public.proactive_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger_type TEXT,
  condition JSONB,
  last_triggered_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.proactive_triggers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own triggers" ON public.proactive_triggers;
CREATE POLICY "Own triggers" ON public.proactive_triggers
  FOR ALL TO authenticated USING (user_id = auth.uid());

-- ====================================================================
-- RPC: search_user_messages
-- Full-text search across message content and conversation titles.
-- Returns conversations with best-matching message snippets.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.search_user_messages(
  q TEXT,
  max_results INT DEFAULT 30
)
RETURNS TABLE (
  conversation_id UUID,
  conversation_title TEXT,
  conversation_updated_at TIMESTAMPTZ,
  message_id UUID,
  message_role TEXT,
  message_snippet TEXT,
  rank FLOAT4
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS \$\$
DECLARE
  ts_query tsquery;
BEGIN
  ts_query := plainto_tsquery('english', q);

  RETURN QUERY
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id,
    c.title AS conversation_title,
    c.updated_at AS conversation_updated_at,
    m.id AS message_id,
    m.role AS message_role,
    ts_headline(
      'english',
      m.content,
      ts_query,
      'MaxWords=20, MinWords=10, StartSel=, StopSel='
    ) AS message_snippet,
    ts_rank(m.search_vector, ts_query) AS rank
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE
    c.user_id = auth.uid()
    AND m.is_active = true
    AND m.search_vector @@ ts_query
  ORDER BY m.conversation_id, rank DESC
  LIMIT max_results;
END;
\$\$;

-- ====================================================================
-- RPC: search_chunks
-- Hybrid search: vector similarity + full-text, merged with RRF.
-- Called by retrieval pipeline.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.search_chunks(
  query_embedding VECTOR(1536),
  query_text TEXT,
  source_types TEXT[],
  match_count INT DEFAULT 20,
  rrf_k INT DEFAULT 60
)
RETURNS TABLE (
  id UUID,
  source_type TEXT,
  source_id UUID,
  source_item_id TEXT,
  content TEXT,
  metadata JSONB,
  rrf_score FLOAT8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS \$\$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      c.id,
      c.source_type,
      c.source_id,
      c.source_item_id,
      c.content,
      c.metadata,
      ROW_NUMBER() OVER (ORDER BY c.embedding <=> query_embedding) AS vec_rank
    FROM public.chunks c
    WHERE
      c.user_id = auth.uid()
      AND (source_types IS NULL OR c.source_type = ANY(source_types))
      AND (c.expires_at IS NULL OR c.expires_at > now())
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  fts_results AS (
    SELECT
      c.id,
      c.source_type,
      c.source_id,
      c.source_item_id,
      c.content,
      c.metadata,
      ROW_NUMBER() OVER (ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', query_text)) DESC) AS fts_rank
    FROM public.chunks c
    WHERE
      c.user_id = auth.uid()
      AND (source_types IS NULL OR c.source_type = ANY(source_types))
      AND (c.expires_at IS NULL OR c.expires_at > now())
      AND c.search_vector @@ plainto_tsquery('english', query_text)
    ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', query_text)) DESC
    LIMIT match_count * 2
  ),
  merged AS (
    SELECT
      COALESCE(v.id, f.id) AS id,
      COALESCE(v.source_type, f.source_type) AS source_type,
      COALESCE(v.source_id, f.source_id) AS source_id,
      COALESCE(v.source_item_id, f.source_item_id) AS source_item_id,
      COALESCE(v.content, f.content) AS content,
      COALESCE(v.metadata, f.metadata) AS metadata,
      COALESCE(1.0 / (rrf_k + v.vec_rank), 0.0)
        + COALESCE(1.0 / (rrf_k + f.fts_rank), 0.0) AS rrf_score
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.id = f.id
  )
  SELECT m.id, m.source_type, m.source_id, m.source_item_id, m.content, m.metadata, m.rrf_score
  FROM merged m
  ORDER BY m.rrf_score DESC
  LIMIT match_count;
END;
\$\$;

-- ====================================================================
-- RPC: search_memories
-- Semantic search over user memories with combined relevance score.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.search_memories(
  query_embedding VECTOR(1536),
  target_user_id UUID,
  target_project_id UUID DEFAULT NULL,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  type TEXT,
  content TEXT,
  confidence FLOAT,
  importance FLOAT,
  access_count INT,
  last_accessed_at TIMESTAMPTZ,
  similarity FLOAT8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS \$\$
BEGIN
  IF target_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    m.type,
    m.content,
    m.confidence,
    m.importance,
    m.access_count,
    m.last_accessed_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memories m
  WHERE
    m.user_id = target_user_id
    AND m.superseded_by IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND (
      target_project_id IS NULL
      OR m.project_id IS NULL
      OR m.project_id = target_project_id
    )
  ORDER BY
    (0.6 * (1 - (m.embedding <=> query_embedding)))
    + (0.2 * CASE
        WHEN m.last_accessed_at IS NULL THEN 0.0
        ELSE GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (now() - m.last_accessed_at)) / 2592000.0)
       END)
    + (0.2 * m.importance)
    DESC
  LIMIT match_count;
END;
\$\$;

-- ====================================================================
-- RPC: insert_usage_event
-- Service-role only insert for usage tracking (bypasses RLS).
-- ====================================================================
CREATE OR REPLACE FUNCTION public.insert_usage_event(
  p_user_id UUID,
  p_event_type TEXT,
  p_model_used TEXT DEFAULT NULL,
  p_tokens_in INT DEFAULT NULL,
  p_tokens_out INT DEFAULT NULL,
  p_cost_usd DECIMAL DEFAULT NULL,
  p_cache_hit BOOLEAN DEFAULT false,
  p_routing_savings_usd DECIMAL DEFAULT NULL,
  p_latency_ms INT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS \$\$
BEGIN
  INSERT INTO public.usage_events (
    user_id, event_type, model_used, tokens_in, tokens_out,
    cost_usd, cache_hit, routing_savings_usd, latency_ms
  ) VALUES (
    p_user_id, p_event_type, p_model_used, p_tokens_in, p_tokens_out,
    p_cost_usd, p_cache_hit, p_routing_savings_usd, p_latency_ms
  );
END;
\$\$;

-- ====================================================================
-- RPC: insert_audit_log
-- Append-only, hash-chained. Called by service role only.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.insert_audit_log(
  p_user_id UUID,
  p_action TEXT,
  p_details JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS \$\$
DECLARE
  v_prev_hash TEXT;
  v_new_hash TEXT;
  v_new_id BIGINT;
BEGIN
  SELECT hash INTO v_prev_hash
  FROM public.audit_logs
  WHERE user_id = p_user_id
  ORDER BY id DESC
  LIMIT 1;

  INSERT INTO public.audit_logs (user_id, action, details, prev_hash)
  VALUES (p_user_id, p_action, p_details, v_prev_hash)
  RETURNING id INTO v_new_id;

  v_new_hash := encode(
    digest(
      v_new_id::TEXT || p_user_id::TEXT || p_action || p_details::TEXT || coalesce(v_prev_hash, ''),
      'sha256'
    ),
    'hex'
  );

  UPDATE public.audit_logs SET hash = v_new_hash WHERE id = v_new_id;
END;
\$\$;

-- ====================================================================
-- Auto-archive conversations after 30 days of inactivity
-- NOTE: Requires pg_cron extension enabled in Supabase dashboard.
-- Run: CREATE EXTENSION IF NOT EXISTS pg_cron; (as superuser)
-- Then uncomment the line below:
-- ====================================================================
-- SELECT cron.schedule('auto-archive-conversations', '0 3 * * *', \$\$
--   UPDATE public.conversations SET status = 'archived'
--   WHERE status = 'active' AND updated_at < NOW() - INTERVAL '30 days';
-- \$\$);

-- Auto-cleanup expired chunks (conversation uploads, URL-in-message)
-- SELECT cron.schedule('cleanup-expired-chunks', '0 4 * * *', \$\$
--   DELETE FROM public.chunks WHERE expires_at IS NOT NULL AND expires_at < NOW();
-- \$\$);

-- Memory decay (daily, applied to memories not accessed in 90+ days)
-- SELECT cron.schedule('memory-decay', '0 2 * * *', \$\$
--   UPDATE public.memories
--   SET importance = GREATEST(0.01, importance * 0.95),
--       updated_at = NOW()
--   WHERE last_accessed_at < NOW() - INTERVAL '90 days'
--     AND superseded_by IS NULL;
--
--   -- Auto-archive memories that have decayed below threshold and are stale
--   UPDATE public.memories
--   SET expires_at = NOW()
--   WHERE importance < 0.1
--     AND last_accessed_at < NOW() - INTERVAL '365 days'
--     AND expires_at IS NULL
--     AND superseded_by IS NULL;
-- \$\$);

-- ========================================================================
-- supabase/migrations/0003_schema_fixes.sql
-- ========================================================================
-- Migration: add missing columns and RLS policies discovered during CRUD audit

-- 1. connectors: add metadata JSONB for Slack team_id/team_name storage
ALTER TABLE public.connectors
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- 2. datasource_files: add error_message for recording processing failures
ALTER TABLE public.datasource_files
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 3. usage_events: add INSERT policy (previously only SELECT existed)
--    Allows authenticated users to insert their own usage events
DROP POLICY IF EXISTS "Own usage events (insert)" ON public.usage_events;
CREATE POLICY "Own usage events (insert)" ON public.usage_events
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ========================================================================
-- supabase/migrations/0004_chat_uploads_policies.sql
-- ========================================================================
-- RLS policies for chat-uploads bucket
-- Files stored under {user_id}/{conversation_id}/{filename}; users access only their folder.
drop policy if exists "chat_uploads_select_own" on storage.objects;
drop policy if exists "chat_uploads_insert_own" on storage.objects;
drop policy if exists "chat_uploads_update_own" on storage.objects;
drop policy if exists "chat_uploads_delete_own" on storage.objects;

create policy "chat_uploads_select_own" on storage.objects for select to authenticated
using (bucket_id = 'chat-uploads' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "chat_uploads_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'chat-uploads' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "chat_uploads_update_own" on storage.objects for update to authenticated
using (bucket_id = 'chat-uploads' and auth.uid()::text = (storage.foldername(name))[1])
with check (bucket_id = 'chat-uploads' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "chat_uploads_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'chat-uploads' and auth.uid()::text = (storage.foldername(name))[1]);

-- ========================================================================
-- supabase/migrations/0004_messages_search_vector.sql
-- ========================================================================
-- Add full-text search vector to messages table for conversation history search
-- Used by exhaustive-strategy Level 2 search.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search
  ON public.messages USING gin(search_vector)
  WHERE is_active = true;

-- ========================================================================
-- supabase/migrations/0005_fix_chat_uploads_storage_rls.sql
-- ========================================================================
-- Fix chat uploads storage permissions.
-- Files are stored as {auth.uid()}/{conversation_id}/{uuid-filename}.

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-uploads', 'chat-uploads', false, 26214400)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "chat_uploads_select_own" on storage.objects;
drop policy if exists "chat_uploads_insert_own" on storage.objects;
drop policy if exists "chat_uploads_update_own" on storage.objects;
drop policy if exists "chat_uploads_delete_own" on storage.objects;

create policy "chat_uploads_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'chat-uploads'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "chat_uploads_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'chat-uploads'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = auth.uid()::text
  and coalesce(array_length(storage.foldername(name), 1), 0) >= 2
);

create policy "chat_uploads_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'chat-uploads'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'chat-uploads'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "chat_uploads_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'chat-uploads'
  and owner = auth.uid()
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ========================================================================
-- supabase/migrations/0006_core_runtime_repair.sql
-- ========================================================================
-- Runtime repair for core chat, uploads, conversations, and rate limiting.
-- This is intentionally idempotent so projects that partially applied older
-- migrations can recover without manual database work.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- Storage bucket and RLS. Do not require storage.objects.owner in the policy:
-- Storage sets owner internally, but the stable user-owned path is the first
-- folder segment: {auth.uid()}/{conversation_id}/{filename}.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-uploads', 'chat-uploads', false, 26214400)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "chat_uploads_select_own" on storage.objects;
drop policy if exists "chat_uploads_insert_own" on storage.objects;
drop policy if exists "chat_uploads_update_own" on storage.objects;
drop policy if exists "chat_uploads_delete_own" on storage.objects;

create policy "chat_uploads_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'chat-uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "chat_uploads_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'chat-uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
  and coalesce(array_length(storage.foldername(name), 1), 0) >= 2
);

create policy "chat_uploads_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'chat-uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'chat-uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "chat_uploads_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'chat-uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Core Phase 1 tables referenced by chat and side panels.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#378ADD',
  status text not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.projects enable row level security;
drop policy if exists "Own projects" on public.projects;
create policy "Own projects" on public.projects
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.conversation_states (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  summary text,
  summary_covers_until int not null default 0,
  conversation_facts jsonb not null default '[]',
  active_topics text[] not null default '{}',
  style_profile jsonb not null default '{}',
  conversation_tone jsonb not null default '{"current":"casual","confidence":0.5,"signals":[]}',
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.conversation_states enable row level security;
drop policy if exists "Own conversation states" on public.conversation_states;
create policy "Own conversation states" on public.conversation_states
  for all to authenticated
  using (conversation_id in (select id from public.conversations where user_id = auth.uid()))
  with check (conversation_id in (select id from public.conversations where user_id = auth.uid()));

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  type text not null,
  content text not null,
  source_conversation_id uuid references public.conversations(id) on delete set null,
  confidence float not null default 0.8,
  importance float not null default 0.5,
  access_count int not null default 0,
  last_accessed_at timestamptz,
  embedding vector(1536),
  expires_at timestamptz,
  version int not null default 1,
  superseded_by uuid references public.memories(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.memories enable row level security;
drop policy if exists "Own memories" on public.memories;
create policy "Own memories" on public.memories
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
alter table public.memories
  add column if not exists search_vector tsvector
    generated always as (to_tsvector('english', content)) stored;
create index if not exists idx_memories_search on public.memories using gin(search_vector) where superseded_by is null;
create index if not exists idx_memories_user_type on public.memories (user_id, type) where superseded_by is null;

create table if not exists public.user_knowledge_models (
  user_id uuid primary key references auth.users(id) on delete cascade,
  identity jsonb not null default '{}',
  active_projects jsonb not null default '[]',
  relationships jsonb not null default '[]',
  communication_style jsonb not null default '{}',
  preferences jsonb not null default '{}',
  anti_preferences jsonb not null default '[]',
  corrections jsonb not null default '[]',
  response_style_dislikes jsonb not null default '[]',
  emotional_patterns jsonb not null default '{}',
  source_trust jsonb not null default '{}',
  opinions jsonb not null default '[]',
  schedule jsonb not null default '{}',
  expertise jsonb not null default '[]',
  correction_count int not null default 0,
  last_pattern_analysis timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.user_knowledge_models enable row level security;
drop policy if exists "Own knowledge model" on public.user_knowledge_models;
create policy "Own knowledge model" on public.user_knowledge_models
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  source_item_id text,
  content text not null,
  metadata jsonb not null default '{}',
  content_hash text,
  embedding vector(1536),
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.chunks enable row level security;
drop policy if exists "Own chunks" on public.chunks;
create policy "Own chunks" on public.chunks
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
alter table public.chunks
  add column if not exists search_vector tsvector
    generated always as (to_tsvector('english', content)) stored;
create index if not exists idx_chunks_search on public.chunks using gin(search_vector);
create index if not exists idx_chunks_source on public.chunks (user_id, source_type, source_id);

create table if not exists public.usage_events (
  id bigserial primary key,
  user_id uuid not null,
  event_type text not null,
  model_used text,
  tokens_in int,
  tokens_out int,
  cost_usd decimal(10, 6),
  cache_hit boolean not null default false,
  routing_savings_usd decimal(10, 6),
  latency_ms int,
  created_at timestamptz not null default timezone('utc', now())
);
alter table public.usage_events enable row level security;
drop policy if exists "Own usage events (read)" on public.usage_events;
create policy "Own usage events (read)" on public.usage_events
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Own usage events (insert)" on public.usage_events;
create policy "Own usage events (insert)" on public.usage_events
  for insert to authenticated with check (user_id = auth.uid());
create index if not exists idx_usage_events_user_date on public.usage_events (user_id, created_at desc);

create table if not exists public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  feedback_type text not null,
  reason text,
  free_text text,
  mismatch_analysis jsonb,
  lesson_extracted text,
  memory_created_id uuid references public.memories(id),
  model_used text,
  response_metadata jsonb,
  processed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);
alter table public.feedback_events enable row level security;
drop policy if exists "Own feedback events" on public.feedback_events;
create policy "Own feedback events" on public.feedback_events
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- RPCs used by retrieval and memory access.
create or replace function public.increment_memory_access(memory_ids uuid[])
returns void
language sql
security definer
set search_path = public
as \$\$
  update public.memories
  set access_count = access_count + 1,
      last_accessed_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = any(memory_ids)
    and user_id = auth.uid();
\$\$;
grant execute on function public.increment_memory_access(uuid[]) to authenticated;

create or replace function public.search_memories(
  query_embedding vector(1536),
  target_user_id uuid,
  target_project_id uuid default null,
  match_count int default 10
)
returns table (
  id uuid,
  type text,
  content text,
  confidence float,
  importance float,
  access_count int,
  last_accessed_at timestamptz,
  similarity float8
)
language plpgsql
security definer
set search_path = public
as \$\$
begin
  if target_user_id != auth.uid() then
    raise exception 'Access denied';
  end if;

  return query
  select
    m.id,
    m.type,
    m.content,
    m.confidence,
    m.importance,
    m.access_count,
    m.last_accessed_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.memories m
  where m.user_id = target_user_id
    and m.embedding is not null
    and m.superseded_by is null
    and (m.expires_at is null or m.expires_at > now())
    and (target_project_id is null or m.project_id is null or m.project_id = target_project_id)
  order by (0.6 * (1 - (m.embedding <=> query_embedding)))
         + (0.2 * case when m.last_accessed_at is null then 0.0 else greatest(0.0, 1.0 - extract(epoch from (now() - m.last_accessed_at)) / 2592000.0) end)
         + (0.2 * m.importance) desc
  limit match_count;
end;
\$\$;
grant execute on function public.search_memories(vector, uuid, uuid, int) to authenticated;

create or replace function public.search_chunks(
  query_embedding vector(1536),
  query_text text,
  source_types text[],
  match_count int default 20,
  rrf_k int default 60
)
returns table (
  id uuid,
  source_type text,
  source_id uuid,
  source_item_id text,
  content text,
  metadata jsonb,
  rrf_score float8
)
language plpgsql
security definer
set search_path = public
as \$\$
begin
  return query
  with vector_results as (
    select c.id, c.source_type, c.source_id, c.source_item_id, c.content, c.metadata,
           row_number() over (order by c.embedding <=> query_embedding) as vec_rank
    from public.chunks c
    where c.user_id = auth.uid()
      and c.embedding is not null
      and (source_types is null or c.source_type = any(source_types))
      and (c.expires_at is null or c.expires_at > now())
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  fts_results as (
    select c.id, c.source_type, c.source_id, c.source_item_id, c.content, c.metadata,
           row_number() over (order by ts_rank(c.search_vector, plainto_tsquery('english', query_text)) desc) as fts_rank
    from public.chunks c
    where c.user_id = auth.uid()
      and (source_types is null or c.source_type = any(source_types))
      and (c.expires_at is null or c.expires_at > now())
      and c.search_vector @@ plainto_tsquery('english', query_text)
    order by ts_rank(c.search_vector, plainto_tsquery('english', query_text)) desc
    limit match_count * 2
  ),
  merged as (
    select coalesce(v.id, f.id) as id,
           coalesce(v.source_type, f.source_type) as source_type,
           coalesce(v.source_id, f.source_id) as source_id,
           coalesce(v.source_item_id, f.source_item_id) as source_item_id,
           coalesce(v.content, f.content) as content,
           coalesce(v.metadata, f.metadata) as metadata,
           coalesce(1.0 / (rrf_k + v.vec_rank), 0.0) + coalesce(1.0 / (rrf_k + f.fts_rank), 0.0) as rrf_score
    from vector_results v
    full outer join fts_results f on v.id = f.id
  )
  select m.id, m.source_type, m.source_id, m.source_item_id, m.content, m.metadata, m.rrf_score
  from merged m
  order by m.rrf_score desc
  limit match_count;
end;
\$\$;
grant execute on function public.search_chunks(vector, text, text[], int, int) to authenticated;

-- ========================================================================
-- supabase/migrations/0007_messages_search_vector.sql
-- ========================================================================
-- Add full-text search vector to messages for conversation history search.
-- Used by exhaustive-strategy Level 2 search (searchConversationHistory).

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search
  ON public.messages USING gin(search_vector)
  WHERE is_active = true;

-- ========================================================================
-- supabase/migrations/0008_memory_context_enhancement.sql
-- ========================================================================
-- Migration: Production memory & context management enhancement
-- Adds: tasks, context_logs, user_memory_preferences, pinned memories,
--       updated scoring RPC, document chunking metadata, full observability.

-- ============================================================
-- 1. Add pinned + tags to memories; update type comment to include
--    the three types added in this release: short_term, long_term, document
-- ============================================================
alter table public.memories
  add column if not exists pinned boolean not null default false,
  add column if not exists tags text[] not null default '{}';

comment on column public.memories.type is
  'Memory type: preference | anti_preference | behavioral | correction | '
  'response_style | project | episodic | semantic | long_term | short_term | document';

create index if not exists idx_memories_pinned
  on public.memories (user_id, pinned) where pinned = true and superseded_by is null;

-- ============================================================
-- 2. tasks table — project/task memory
-- ============================================================
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  title text not null default '',
  goal text not null default '',
  status text not null default 'active'
    check (status in ('active','paused','completed','cancelled')),
  current_step text,
  completed_steps text[] not null default '{}',
  open_questions text[] not null default '{}',
  decisions jsonb not null default '[]',
  artifacts jsonb not null default '[]',
  next_actions text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.tasks enable row level security;
drop policy if exists "Own tasks" on public.tasks;
create policy "Own tasks" on public.tasks
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists idx_tasks_user on public.tasks (user_id, status);
create index if not exists idx_tasks_conversation on public.tasks (conversation_id) where conversation_id is not null;
create index if not exists idx_tasks_project on public.tasks (project_id) where project_id is not null;

-- ============================================================
-- 3. user_memory_preferences — per-user memory settings
-- ============================================================
create table if not exists public.user_memory_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  memory_enabled boolean not null default true,
  auto_extract boolean not null default true,
  sensitive_domains text[] not null default '{}',
  excluded_types text[] not null default '{}',
  max_memory_age_days int,
  min_confidence_threshold float not null default 0.6,
  max_memories_per_call int not null default 10,
  max_chunks_per_call int not null default 8,
  store_conversation_summaries boolean not null default true,
  allow_cross_project_memory boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.user_memory_preferences enable row level security;
drop policy if exists "Own memory preferences" on public.user_memory_preferences;
create policy "Own memory preferences" on public.user_memory_preferences
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- 4. context_logs — full observability per LLM call
-- ============================================================
create table if not exists public.context_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  provider text not null,
  model text not null,
  tokens_in int,
  tokens_out int,
  tokens_saved int not null default 0,
  savings_pct int not null default 0,
  cost_usd decimal(10, 6),
  latency_ms int,
  retrieved_memory_ids uuid[] not null default '{}',
  retrieved_chunk_ids uuid[] not null default '{}',
  task_id uuid references public.tasks(id) on delete set null,
  ranking_scores jsonb not null default '{}',
  context_sections jsonb not null default '{}',
  warnings text[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.context_logs enable row level security;
drop policy if exists "Own context logs (read)" on public.context_logs;
create policy "Own context logs (read)" on public.context_logs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Own context logs (insert)" on public.context_logs;
create policy "Own context logs (insert)" on public.context_logs
  for insert to authenticated with check (user_id = auth.uid());

create index if not exists idx_context_logs_user_conv
  on public.context_logs (user_id, conversation_id, created_at desc);
create index if not exists idx_context_logs_message
  on public.context_logs (message_id) where message_id is not null;

-- ============================================================
-- 5. Enhance usage_events — add conversation_id
-- ============================================================
alter table public.usage_events
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null;

-- ============================================================
-- 6. Document chunks — add chunking metadata columns
-- ============================================================
alter table public.chunks
  add column if not exists chunk_index int not null default 0,
  add column if not exists chunk_total int,
  add column if not exists token_count int,
  add column if not exists heading text,
  add column if not exists page_number int,
  add column if not exists section_title text,
  add column if not exists document_name text;

-- ============================================================
-- 7. Replace search_memories RPC with spec-compliant hybrid scoring
--    score = semantic*0.45 + keyword*0.20 + recency*0.15 + importance*0.15 + pinned*0.05
-- ============================================================
create or replace function public.search_memories(
  query_embedding vector(1536),
  target_user_id uuid,
  target_project_id uuid default null,
  match_count int default 10,
  query_text text default null
)
returns table (
  id uuid,
  type text,
  content text,
  confidence float,
  importance float,
  pinned boolean,
  access_count int,
  last_accessed_at timestamptz,
  source_conversation_id uuid,
  similarity float8,
  hybrid_score float8
)
language plpgsql
security definer
set search_path = public
as \$\$
begin
  if target_user_id != auth.uid() then
    raise exception 'Access denied';
  end if;

  return query
  with base as (
    select
      m.id,
      m.type,
      m.content,
      m.confidence,
      m.importance,
      m.pinned,
      m.access_count,
      m.last_accessed_at,
      m.source_conversation_id,
      -- semantic similarity (cosine distance → similarity)
      (1 - (m.embedding <=> query_embedding)) as semantic_sim,
      -- keyword match via ts_rank (0–1 scaled)
      case
        when query_text is not null and query_text <> ''
          then least(1.0, ts_rank(m.search_vector, plainto_tsquery('english', query_text)) * 5.0)
        else 0.0
      end as kw_score,
      -- recency score: 1.0 if accessed today, decays to 0 over 30 days
      case
        when m.last_accessed_at is null then 0.0
        else greatest(0.0, 1.0 - extract(epoch from (now() - m.last_accessed_at)) / 2592000.0)
      end as recency
    from public.memories m
    where m.user_id = target_user_id
      and m.embedding is not null
      and m.superseded_by is null
      and (m.expires_at is null or m.expires_at > now())
      and (target_project_id is null or m.project_id is null or m.project_id = target_project_id)
  )
  select
    b.id,
    b.type,
    b.content,
    b.confidence,
    b.importance,
    b.pinned,
    b.access_count,
    b.last_accessed_at,
    b.source_conversation_id,
    b.semantic_sim as similarity,
    -- spec formula: semantic*0.45 + keyword*0.20 + recency*0.15 + importance*0.15 + pinned*0.05
    (b.semantic_sim * 0.45)
    + (b.kw_score      * 0.20)
    + (b.recency       * 0.15)
    + (b.importance    * 0.15)
    + (case when b.pinned then 0.05 else 0.0 end) as hybrid_score
  from base b
  order by
    -- pinned memories always surface first
    b.pinned desc,
    -- then by hybrid score
    (b.semantic_sim * 0.45) + (b.kw_score * 0.20) + (b.recency * 0.15)
    + (b.importance * 0.15) + (case when b.pinned then 0.05 else 0.0 end) desc
  limit match_count;
end;
\$\$;
grant execute on function public.search_memories(vector, uuid, uuid, int, text) to authenticated;

-- ============================================================
-- 8. RPC: get_active_task — load active task for a conversation
-- ============================================================
create or replace function public.get_active_task(
  target_conversation_id uuid
)
returns table (
  id uuid,
  title text,
  goal text,
  status text,
  current_step text,
  completed_steps text[],
  open_questions text[],
  decisions jsonb,
  artifacts jsonb,
  next_actions text[],
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as \$\$
begin
  return query
  select
    t.id, t.title, t.goal, t.status, t.current_step,
    t.completed_steps, t.open_questions, t.decisions,
    t.artifacts, t.next_actions, t.updated_at
  from public.tasks t
  where t.conversation_id = target_conversation_id
    and t.user_id = auth.uid()
    and t.status = 'active'
  order by t.updated_at desc
  limit 1;
end;
\$\$;
grant execute on function public.get_active_task(uuid) to authenticated;

-- ============================================================
-- 9. RPC: upsert_task — create or update task from extraction
-- ============================================================
create or replace function public.upsert_task(
  p_conversation_id uuid,
  p_title text,
  p_goal text,
  p_current_step text default null,
  p_completed_steps text[] default null,
  p_open_questions text[] default null,
  p_decisions jsonb default null,
  p_next_actions text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as \$\$
declare
  v_task_id uuid;
begin
  -- Try to update existing active task for this conversation
  update public.tasks
  set
    title = coalesce(p_title, title),
    goal = coalesce(nullif(p_goal,''), goal),
    current_step = coalesce(p_current_step, current_step),
    completed_steps = coalesce(p_completed_steps, completed_steps),
    open_questions = coalesce(p_open_questions, open_questions),
    decisions = coalesce(p_decisions, decisions),
    next_actions = coalesce(p_next_actions, next_actions),
    updated_at = now()
  where conversation_id = p_conversation_id
    and user_id = auth.uid()
    and status = 'active'
  returning id into v_task_id;

  -- If no active task found, create one
  if v_task_id is null then
    insert into public.tasks
      (user_id, conversation_id, title, goal, current_step, completed_steps,
       open_questions, decisions, next_actions)
    values
      (auth.uid(), p_conversation_id, p_title, p_goal,
       p_current_step, coalesce(p_completed_steps, '{}'),
       coalesce(p_open_questions, '{}'), coalesce(p_decisions, '[]'),
       coalesce(p_next_actions, '{}'))
    returning id into v_task_id;
  end if;

  return v_task_id;
end;
\$\$;
grant execute on function public.upsert_task(uuid, text, text, text, text[], text[], jsonb, text[]) to authenticated;

-- ============================================================
-- 10. RPC: insert_context_log — service-role logging for each call
-- ============================================================
create or replace function public.insert_context_log(
  p_user_id uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_provider text,
  p_model text,
  p_tokens_in int,
  p_tokens_out int,
  p_tokens_saved int,
  p_savings_pct int,
  p_cost_usd decimal,
  p_latency_ms int,
  p_retrieved_memory_ids uuid[],
  p_retrieved_chunk_ids uuid[],
  p_task_id uuid,
  p_ranking_scores jsonb,
  p_context_sections jsonb,
  p_warnings text[]
)
returns uuid
language sql
security definer
set search_path = public
as \$\$
  insert into public.context_logs (
    user_id, conversation_id, message_id, provider, model,
    tokens_in, tokens_out, tokens_saved, savings_pct, cost_usd, latency_ms,
    retrieved_memory_ids, retrieved_chunk_ids, task_id,
    ranking_scores, context_sections, warnings
  ) values (
    p_user_id, p_conversation_id, p_message_id, p_provider, p_model,
    p_tokens_in, p_tokens_out, p_tokens_saved, p_savings_pct, p_cost_usd, p_latency_ms,
    p_retrieved_memory_ids, p_retrieved_chunk_ids, p_task_id,
    p_ranking_scores, p_context_sections, p_warnings
  )
  returning id;
\$\$;
grant execute on function public.insert_context_log(uuid,uuid,uuid,text,text,int,int,int,int,decimal,int,uuid[],uuid[],uuid,jsonb,jsonb,text[]) to authenticated;

-- ============================================================
-- 11. RPC: get_context_log — retrieve last call log for debugger
-- ============================================================
create or replace function public.get_context_log(
  p_conversation_id uuid,
  p_limit int default 1
)
returns table (
  id uuid,
  provider text,
  model text,
  tokens_in int,
  tokens_out int,
  tokens_saved int,
  savings_pct int,
  cost_usd decimal,
  latency_ms int,
  retrieved_memory_ids uuid[],
  retrieved_chunk_ids uuid[],
  task_id uuid,
  ranking_scores jsonb,
  context_sections jsonb,
  warnings text[],
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as \$\$
begin
  return query
  select
    cl.id, cl.provider, cl.model, cl.tokens_in, cl.tokens_out,
    cl.tokens_saved, cl.savings_pct, cl.cost_usd, cl.latency_ms,
    cl.retrieved_memory_ids, cl.retrieved_chunk_ids, cl.task_id,
    cl.ranking_scores, cl.context_sections, cl.warnings, cl.created_at
  from public.context_logs cl
  where cl.conversation_id = p_conversation_id
    and cl.user_id = auth.uid()
  order by cl.created_at desc
  limit p_limit;
end;
\$\$;
grant execute on function public.get_context_log(uuid, int) to authenticated;

-- ========================================================================
-- supabase/migrations/0009_production_hardening.sql
-- ========================================================================
-- Migration 0009: Production hardening
--
-- Adds:
--   1. message.status column (streaming | completed | failed) — durability for partial streams
--   2. memory_jobs table — durable async queue replacing fire-and-forget waitUntil()
--   3. user_knowledge_models.identity_sources — provenance tracking (user_asserted vs inferred)
--   4. user_memory_preferences.web_search_* — explicit policy gates for web search fallback

-- ---------------------------------------------------------------------------
-- 1. Message streaming status + updated_at
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('streaming', 'completed', 'failed'));

-- updated_at is needed by the streaming durability pattern: the assistant message
-- is pre-inserted as status='streaming' then updated to 'completed'/'failed'.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Partial/failed messages from prior code have no status row — default to completed.
-- Index allows the client to query for stuck streaming messages to show recovery UI.
CREATE INDEX IF NOT EXISTS idx_messages_status_streaming
  ON public.messages(conversation_id, created_at DESC)
  WHERE status = 'streaming';

-- ---------------------------------------------------------------------------
-- 2. Durable memory job queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id UUID        NOT NULL,
  project_id      UUID        NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  retries         SMALLINT    NOT NULL DEFAULT 0,
  max_retries     SMALLINT    NOT NULL DEFAULT 3,
  error           TEXT        NULL,
  payload         JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claim query: pending jobs ordered by scheduled_at, partial index for speed.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_pending
  ON public.memory_jobs(scheduled_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_memory_jobs_user
  ON public.memory_jobs(user_id, created_at DESC);

ALTER TABLE public.memory_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Own memory jobs" ON public.memory_jobs
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. UKM identity provenance
-- ---------------------------------------------------------------------------
-- Tracks how each identity field was established:
--   'user_asserted'  — user explicitly stated (e.g. "my name is X")
--   'inferred'       — assistant inferred from context
--   'observed'       — system-observed (repeated pattern over N exchanges)
ALTER TABLE public.user_knowledge_models
  ADD COLUMN IF NOT EXISTS identity_sources JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.user_knowledge_models.identity_sources IS
  'Provenance map for identity fields: { "name": "user_asserted", "role": "inferred", ... }. '
  'Values: user_asserted | inferred | observed';

-- ---------------------------------------------------------------------------
-- 4. Web search policy on user_memory_preferences
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_memory_preferences
  ADD COLUMN IF NOT EXISTS web_search_enabled              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS web_search_requires_confirmation BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_memory_preferences.web_search_enabled IS
  'Whether the system may fall back to Bing web search when local retrieval quality is low.';
COMMENT ON COLUMN public.user_memory_preferences.web_search_requires_confirmation IS
  'When true, web search triggers a confirmation event before the query is sent.';

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
`;
