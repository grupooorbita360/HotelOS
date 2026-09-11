-- HotelOS: catálogo inicial de permisos y roles globales de sistema.
-- Esto NO es lógica de negocio de un módulo: es la base de RBAC que ya usan
-- las políticas RLS definidas en 0006/0007 (hotel.settings.manage, staff.manage).
-- Cada módulo futuro (Reservaciones, Rack, Recepción, Habitaciones, Caja)
-- agregará sus propios permisos vía nuevas migraciones, nunca editando estas filas a mano.

insert into public.permissions (code, module, description) values
  ('hotel.settings.manage', 'core', 'Editar configuración y políticas del hotel'),
  ('staff.manage', 'core', 'Invitar/editar personal y asignar roles dentro del hotel'),
  ('reservations.create', 'reservations', 'Crear una reservación'),
  ('reservations.cancel', 'reservations', 'Cancelar una reservación'),
  ('checkin.perform', 'front_desk', 'Realizar el check-in de una reservación'),
  ('checkout.perform', 'front_desk', 'Realizar el check-out de una reservación'),
  ('room.change', 'front_desk', 'Cambiar la habitación asignada a una reservación'),
  ('payments.register', 'billing', 'Registrar un pago o cargo'),
  ('rooms.manage', 'housekeeping', 'Actualizar el estado de limpieza/mantenimiento de una habitación')
on conflict (code) do nothing;

insert into public.roles (hotel_id, name, is_system, description) values
  (null, 'hotel_admin', true, 'Administrador del hotel: acceso total dentro de su(s) hotel(es)'),
  (null, 'front_desk', true, 'Recepción: reservaciones, check-in/out, cambios de habitación'),
  (null, 'housekeeping', true, 'Ama de llaves: estado de habitaciones'),
  (null, 'accounting', true, 'Caja/contabilidad: pagos y cargos')
on conflict (name) where hotel_id is null do nothing;

-- hotel_admin: todos los permisos definidos hasta ahora.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'hotel_admin' and r.hotel_id is null
on conflict do nothing;

-- front_desk
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'reservations.create', 'reservations.cancel',
  'checkin.perform', 'checkout.perform', 'room.change'
)
where r.name = 'front_desk' and r.hotel_id is null
on conflict do nothing;

-- housekeeping
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('rooms.manage')
where r.name = 'housekeeping' and r.hotel_id is null
on conflict do nothing;

-- accounting
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('payments.register')
where r.name = 'accounting' and r.hotel_id is null
on conflict do nothing;
