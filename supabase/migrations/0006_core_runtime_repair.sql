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
as $$
  update public.memories
  set access_count = access_count + 1,
      last_accessed_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = any(memory_ids)
    and user_id = auth.uid();
$$;
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
as $$
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
$$;
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
as $$
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
$$;
grant execute on function public.search_chunks(vector, text, text[], int, int) to authenticated;
