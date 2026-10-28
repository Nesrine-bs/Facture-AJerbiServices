-- Run once in the Supabase SQL Editor for the A Jerbi shared invoice workspace.
create table if not exists public.app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique
);

create table if not exists public.app_settings (
  id integer primary key check (id = 1),
  data jsonb not null default '{"nextNumber":16,"taxRate":19,"stamp":1}'::jsonb
);

insert into public.app_settings (id, data)
values (1, '{"nextNumber":16,"taxRate":19,"stamp":1}'::jsonb)
on conflict (id) do nothing;

create table if not exists public.invoices (
  id text primary key,
  number integer not null unique,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_members enable row level security;
alter table public.app_settings enable row level security;
alter table public.invoices enable row level security;
alter table public.invoices replica identity full;

-- A user may only read their own membership row. Membership is added by the owner in SQL.
drop policy if exists "members can read own membership" on public.app_members;
create policy "members can read own membership" on public.app_members
  for select to authenticated using (user_id = auth.uid());
grant select on public.app_members to authenticated;

create or replace function public.is_invoice_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_members where user_id = auth.uid());
$$;
revoke all on function public.is_invoice_member() from public, anon;
grant execute on function public.is_invoice_member() to authenticated;

drop policy if exists "members manage shared invoices" on public.invoices;
create policy "members manage shared invoices" on public.invoices
  for all to authenticated
  using (public.is_invoice_member())
  with check (public.is_invoice_member());
grant select, insert, update, delete on public.invoices to authenticated;

drop policy if exists "members manage shared settings" on public.app_settings;
create policy "members manage shared settings" on public.app_settings
  for all to authenticated
  using (public.is_invoice_member())
  with check (public.is_invoice_member());
grant select, update on public.app_settings to authenticated;

-- Allocate invoice numbers atomically so two users cannot receive the same number.
create or replace function public.create_invoice(invoice_payload jsonb)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  assigned_number integer;
  saved_invoice jsonb;
begin
  update public.app_settings
  set data = jsonb_set(data, '{nextNumber}', to_jsonb((data->>'nextNumber')::integer + 1), true)
  where id = 1
  returning (data->>'nextNumber')::integer - 1 into assigned_number;

  if assigned_number is null then
    raise exception 'Invoice settings are not initialized';
  end if;

  saved_invoice := jsonb_set(invoice_payload, '{number}', to_jsonb(assigned_number), true);
  insert into public.invoices (id, number, data)
  values (saved_invoice->>'id', assigned_number, saved_invoice);
  return saved_invoice;
end;
$$;
revoke all on function public.create_invoice(jsonb) from public, anon;
grant execute on function public.create_invoice(jsonb) to authenticated;

-- Enable database change events for the live shared history.
alter publication supabase_realtime add table public.invoices;
alter publication supabase_realtime add table public.app_settings;
