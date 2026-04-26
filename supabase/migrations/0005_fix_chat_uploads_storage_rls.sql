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
