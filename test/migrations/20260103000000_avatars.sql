insert into storage.buckets (id, name) values ('avatars', 'avatars');
create policy "own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
