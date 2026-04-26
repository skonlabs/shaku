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
