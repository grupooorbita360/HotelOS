-- HotelOS / Configuracion: la pantalla de Usuarios y Roles necesita mostrar
-- el correo de cada miembro del staff para poder identificarlo (el nombre
-- puede venir vacio si el usuario todavia no completa su alta). profiles no
-- tenia columna email (0003_profiles.sql): el correo solo vivia en
-- auth.users, que un usuario autenticado normal no puede leer via
-- PostgREST (no es un esquema expuesto por la API, y el helper
-- find_user_id_by_email de 0031 solo devuelve un id, nunca datos crudos).
--
-- Se agrega profiles.email como copia de solo-lectura para la aplicacion,
-- sincronizada por trigger -- igual patron que set_audit_fields(): nunca se
-- llena a mano ni se confia en lo que mande el cliente.

alter table public.profiles add column email text;

comment on column public.profiles.email is
  'Copia de auth.users.email mantenida por trigger, solo para mostrar en la interfaz (ej. lista de staff en Configuracion). auth.users sigue siendo la fuente de verdad de identidad.';

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is distinct from u.email;

-- Reemplaza la funcion de 0003 (no se edita esa migracion ya aplicada) para
-- que el alta automatica de perfil tambien copie el correo.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- auth.users.email puede cambiar despues del alta (ej. el usuario lo edita
-- en su cuenta); mantener profiles.email sincronizado con un segundo
-- trigger, igual de minimo que el de alta.
create or replace function public.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger trg_on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.handle_auth_user_email_change();
