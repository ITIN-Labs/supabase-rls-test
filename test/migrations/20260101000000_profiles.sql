create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null
);
alter table public.profiles enable row level security;
create policy "profiles are readable when signed in" on public.profiles
  for select to authenticated using (true);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), 'someone'));
  return new;
end
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
