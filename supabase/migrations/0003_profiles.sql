-- HotelOS: perfil público de cada usuario autenticado (1:1 con auth.users).
-- auth.users sigue siendo la fuente de verdad de identidad/credenciales;
-- profiles guarda datos de aplicación y el flag de administrador de plataforma.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  is_platform_admin boolean not null default false,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Datos de aplicación por usuario. is_platform_admin identifica staff de HotelOS (soporte/ops), no de un hotel en particular.';
comment on column public.profiles.is_platform_admin is
  'Sólo asignable manualmente (dashboard/servicio), nunca por el propio usuario. Ver políticas RLS en 0006.';

-- profiles no tiene created_by/updated_by (el "creador" siempre es el propio
-- usuario vía signup), pero sí necesita mantener updated_at automáticamente.
create or replace function public.set_updated_at_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at_only();

-- Alta automática del perfil cuando se crea un usuario en auth.users.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

alter table public.profiles enable row level security;
-- Sin políticas todavía => acceso denegado por defecto (fail-closed) hasta 0006.
