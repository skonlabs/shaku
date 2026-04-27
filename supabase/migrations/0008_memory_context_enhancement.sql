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
as $$
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
$$;
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
as $$
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
$$;
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
as $$
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
$$;
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
as $$
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
$$;
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
as $$
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
$$;
grant execute on function public.get_context_log(uuid, int) to authenticated;
