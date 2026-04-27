-- Migration 0009: Production hardening
--
-- Adds:
--   1. message.status column (streaming | completed | failed) — durability for partial streams
--   2. memory_jobs table — durable async queue replacing fire-and-forget waitUntil()
--   3. user_knowledge_models.identity_sources — provenance tracking (user_asserted vs inferred)
--   4. user_memory_preferences.web_search_* — explicit policy gates for web search fallback

-- ---------------------------------------------------------------------------
-- 1. Message streaming status
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('streaming', 'completed', 'failed'));

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
