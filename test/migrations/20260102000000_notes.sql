create table public.notes (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references public.profiles (id),
  body text not null
);
create table public.note_readers (
  note_id bigint references public.notes (id) on delete cascade,
  user_id uuid references public.profiles (id),
  primary key (note_id, user_id)
);
alter table public.notes enable row level security;
alter table public.note_readers enable row level security;

create policy "owners do anything" on public.notes
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "readers read" on public.notes for select to authenticated using (
  exists (select 1 from public.note_readers r where r.note_id = id and r.user_id = auth.uid())
);
-- security definer reads notes past its own policies, so the two tables' policies don't recurse.
create function public.owns_note(note bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.notes where id = note and owner_id = auth.uid())
$$;
create policy "readers see their own rows" on public.note_readers for select to authenticated
  using (user_id = auth.uid());
create policy "owners share" on public.note_readers for all to authenticated
  using (public.owns_note(note_id)) with check (public.owns_note(note_id));

-- A custom check that refuses with the same code Postgres uses for permissions.
create function public.clear_notes() returns void language plpgsql as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  delete from public.notes where owner_id = auth.uid();
end
$$;

create function public.always_fails() returns void language plpgsql as $$
begin
  raise exception 'something else went wrong';
end
$$;
