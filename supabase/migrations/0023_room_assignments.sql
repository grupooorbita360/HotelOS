-- HotelOS / Recepcion: AsignacionHabitacion -- historial de habitacion
-- fisica asignada a una Estancia. Solo una activa (released_at = NULL) por
-- estancia. MVP: solo asignacion equivalente (la habitacion debe ser del
-- mismo room_type_id que se vendio en reservation_stays) -- sin upgrade ni
-- downgrade todavia.

create table public.room_assignments (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  stay_id uuid not null references public.stays (id) on delete cascade,
  room_id uuid not null references public.rooms (id),

  assigned_at timestamptz not null default now(),
  released_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.room_assignments is
  'Historial de habitacion fisica por estancia. Solo una fila activa (released_at is null) por stay_id.';

create trigger trg_room_assignments_audit
  before insert or update on public.room_assignments
  for each row execute function public.set_audit_fields();

create unique index idx_room_assignments_one_active_per_stay
  on public.room_assignments (stay_id) where released_at is null;

create index idx_room_assignments_room_active
  on public.room_assignments (room_id) where released_at is null;

alter table public.room_assignments enable row level security;

create policy "room_assignments_select_member_or_platform_admin"
  on public.room_assignments for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Sin INSERT/UPDATE directos: solo via assign_room()/release_room_assignment()
-- en 0026 (SECURITY DEFINER), que valida equivalencia de tipo y permisos.
