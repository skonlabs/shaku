-- Add full-text search vector to messages for conversation history search.
-- Used by exhaustive-strategy Level 2 search (searchConversationHistory).

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search
  ON public.messages USING gin(search_vector)
  WHERE is_active = true;
