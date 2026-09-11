-- HotelOS: tabla raíz del multi-tenant. Cada hotel es un cliente aislado.
-- Las políticas de RLS se agregan en 0006_rls_policies.sql, una vez que
-- existen las tablas de roles/permisos de las que dependen. RLS se activa
-- aquí mismo para que la tabla nunca quede expuesta sin protección.

create table public.hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'basico' check (plan in ('basico', 'plus', 'pro')),
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended', 'canceled')),
  timezone text not null default 'America/Mexico_City',
  country text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.hotels is
  'Tenant raíz. Toda tabla operativa referencia hotel_id y se aísla vía RLS.';
comment on column public.hotels.plan is
  'Plan comercial del hotel (Básico/Plus/Pro). Controla qué módulos/límites aplican; ver hotel_policies.';

create trigger trg_hotels_audit
  before insert or update on public.hotels
  for each row execute function public.set_audit_fields();

alter table public.hotels enable row level security;
-- Sin políticas todavía => acceso denegado por defecto (fail-closed) hasta 0006.
