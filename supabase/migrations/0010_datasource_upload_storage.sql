-- Ensure library/data-source uploads have their own private bucket and RLS.
-- Path format: {auth.uid()}/{datasource_file_id}/{filename-or-relative-path}

insert into storage.buckets (id, name, public, file_size_limit)
values ('datasource-files', 'datasource-files', false, 52428800)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "datasource_files_select_own" on storage.objects;
drop policy if exists "datasource_files_insert_own" on storage.objects;
drop policy if exists "datasource_files_update_own" on storage.objects;
drop policy if exists "datasource_files_delete_own" on storage.objects;

create policy "datasource_files_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'datasource-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "datasource_files_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'datasource-files'
  and (storage.foldername(name))[1] = auth.uid()::text
  and coalesce(array_length(storage.foldername(name), 1), 0) >= 3
);

create policy "datasource_files_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'datasource-files'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'datasource-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "datasource_files_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'datasource-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);
