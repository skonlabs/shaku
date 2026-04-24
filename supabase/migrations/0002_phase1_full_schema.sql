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
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_email_key'
  ) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_email_key UNIQUE (email);
  END IF;
END$$;

-- conversations: proper FK on project_id (will be added once projects table exists)
-- (Applied below after projects table creation)

-- messages: fix share_id to UUID type (migrate existing text values)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'share_id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE public.messages DROP COLUMN share_id;
    ALTER TABLE public.messages ADD COLUMN share_id UUID UNIQUE DEFAULT NULL;
  END IF;
END$$;

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

CREATE POLICY IF NOT EXISTS "Own projects" ON public.projects
  FOR ALL TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_projects_updated_at ON public.projects;
CREATE TRIGGER set_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Now add the FK on conversations.project_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_project_id_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END$$;

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
CREATE POLICY IF NOT EXISTS "Public read shared responses" ON public.shared_responses
  FOR SELECT TO anon, authenticated USING (true);

-- Owner insert: only the owner can create shares
CREATE POLICY IF NOT EXISTS "Owner insert shared responses" ON public.shared_responses
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- Owner delete: only the owner can delete their shares
CREATE POLICY IF NOT EXISTS "Owner delete shared responses" ON public.shared_responses
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Atomic view count increment (avoids read-modify-write race, callable by anon)
CREATE OR REPLACE FUNCTION public.increment_shared_view_count(share_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.shared_responses SET view_count = view_count + 1 WHERE id = share_id;
$$;

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

CREATE POLICY IF NOT EXISTS "Own conversation states" ON public.conversation_states
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

CREATE POLICY IF NOT EXISTS "Own memories" ON public.memories
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

CREATE POLICY IF NOT EXISTS "Own knowledge model" ON public.user_knowledge_models
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

CREATE POLICY IF NOT EXISTS "Own folders" ON public.datasource_folders
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

CREATE POLICY IF NOT EXISTS "Own datasource files" ON public.datasource_files
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

CREATE POLICY IF NOT EXISTS "Own connectors" ON public.connectors
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

CREATE POLICY IF NOT EXISTS "Own chunks" ON public.chunks
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

CREATE POLICY IF NOT EXISTS "Own feedback events" ON public.feedback_events
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

CREATE POLICY IF NOT EXISTS "Own actions" ON public.actions
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

CREATE POLICY IF NOT EXISTS "Own audit logs (read)" ON public.audit_logs
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

CREATE POLICY IF NOT EXISTS "Own usage events (read)" ON public.usage_events
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

CREATE POLICY IF NOT EXISTS "Own triggers" ON public.proactive_triggers
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
AS $$
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
$$;

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
AS $$
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
$$;

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
AS $$
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
$$;

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
AS $$
BEGIN
  INSERT INTO public.usage_events (
    user_id, event_type, model_used, tokens_in, tokens_out,
    cost_usd, cache_hit, routing_savings_usd, latency_ms
  ) VALUES (
    p_user_id, p_event_type, p_model_used, p_tokens_in, p_tokens_out,
    p_cost_usd, p_cache_hit, p_routing_savings_usd, p_latency_ms
  );
END;
$$;

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
AS $$
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
$$;

-- ====================================================================
-- Auto-archive conversations after 30 days of inactivity
-- NOTE: Requires pg_cron extension enabled in Supabase dashboard.
-- Run: CREATE EXTENSION IF NOT EXISTS pg_cron; (as superuser)
-- Then uncomment the line below:
-- ====================================================================
-- SELECT cron.schedule('auto-archive-conversations', '0 3 * * *', $$
--   UPDATE public.conversations SET status = 'archived'
--   WHERE status = 'active' AND updated_at < NOW() - INTERVAL '30 days';
-- $$);

-- Auto-cleanup expired chunks (conversation uploads, URL-in-message)
-- SELECT cron.schedule('cleanup-expired-chunks', '0 4 * * *', $$
--   DELETE FROM public.chunks WHERE expires_at IS NOT NULL AND expires_at < NOW();
-- $$);

-- Memory decay (daily, applied to memories not accessed in 90+ days)
-- SELECT cron.schedule('memory-decay', '0 2 * * *', $$
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
-- $$);
