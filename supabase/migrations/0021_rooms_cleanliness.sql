-- HotelOS / Recepcion: placeholder minimo de limpieza en rooms, necesario
-- para el gate de checkin_permite_sucia. El modulo real de Housekeeping
-- (estatus detallado, tareas, tiempos) se construye aparte; esto es
-- solo el booleano indispensable para que Recepcion funcione hoy, igual
-- que room_types/rooms fueron el minimo necesario para Reservaciones.

alter table public.rooms
  add column is_clean boolean not null default true;

comment on column public.rooms.is_clean is
  'Placeholder minimo hasta que exista el modulo Housekeeping. Usado por reception_settings.checkin_permite_sucia.';

-- La politica de escritura de "rooms" (0010) solo permitia
-- hotel.settings.manage. Housekeeping (rol con permiso rooms.manage) debe
-- poder marcar una habitacion limpia/sucia sin ser administrador del hotel.
create policy "rooms_update_rooms_manage"
  on public.rooms for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'rooms.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'rooms.manage'));

