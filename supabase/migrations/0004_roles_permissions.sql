-- HotelOS: catálogo de roles, catálogo de permisos, su mapeo, y la asignación
-- de rol(es) a un usuario dentro de un hotel específico (el límite de tenant).

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  -- hotel_id nulo = rol global de sistema disponible para todos los hoteles
  -- (hotel_admin, front_desk, housekeeping, accounting...).
  -- hotel_id con valor = rol personalizado, exclusivo de ese hotel (futuro).
  hotel_id uuid references public.hotels (id) on delete cascade,
  name text not null,
  description text,
  is_system boolean not null default false,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  -- unique(hotel_id, name) no alcanza para roles globales: Postgres trata
  -- cada NULL como distinto, así que se refuerza con un índice parcial.
  unique (hotel_id, name)
);

create unique index idx_roles_unique_global_name
  on public.roles (name)
  where hotel_id is null;

comment on table public.roles is
  'Catálogo de roles. En v1 sólo el equipo de plataforma crea/edita roles (ver RLS); los hoteles asignan roles existentes a su personal.';

create trigger trg_roles_audit
  before insert or update on public.roles
  for each row execute function public.set_audit_fields();

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  module text not null,
  description text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.permissions is
  'Catálogo de permisos atómicos, ej. reservations.create, payments.register, checkin.perform. El código de servidor valida contra esto en cada acción sensible.';

create trigger trg_permissions_audit
  before insert or update on public.permissions
  for each row execute function public.set_audit_fields();

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  primary key (role_id, permission_id)
);

comment on table public.role_permissions is
  'Mapeo rol -> permisos. Un rol puede tener varios permisos; un permiso puede estar en varios roles.';

create table public.user_hotel_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete restrict,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (user_id, hotel_id, role_id)
);

comment on table public.user_hotel_roles is
  'Asignación de un rol a un usuario dentro de un hotel concreto. Esta tabla es el límite real del multi-tenant a nivel de acceso de usuarios: un usuario sólo opera en los hoteles donde tiene una fila activa aquí.';

create trigger trg_user_hotel_roles_audit
  before insert or update on public.user_hotel_roles
  for each row execute function public.set_audit_fields();

create index idx_user_hotel_roles_user on public.user_hotel_roles (user_id) where is_active;
create index idx_user_hotel_roles_hotel on public.user_hotel_roles (hotel_id) where is_active;

alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_hotel_roles enable row level security;
-- Sin políticas todavía => acceso denegado por defecto (fail-closed) hasta 0006.
