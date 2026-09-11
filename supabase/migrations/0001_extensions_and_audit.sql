-- HotelOS: extensiones base y utilidades de auditoría reutilizables
-- Estas funciones se aplican a TODA tabla operativa (ver CLAUDE.md, principio 3).

create extension if not exists pgcrypto;

-- created_at/created_by/updated_at/updated_by nunca deben confiar en lo que
-- envía el cliente: este trigger los fija siempre desde el servidor.
create or replace function public.set_audit_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.updated_at := now();
    new.updated_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function public.set_audit_fields() is
  'Fija created_at/created_by/updated_at/updated_by desde el servidor en cada INSERT/UPDATE. Nunca confiar en estos campos si vienen del cliente.';
