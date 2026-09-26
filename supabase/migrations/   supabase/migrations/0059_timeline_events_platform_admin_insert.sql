-- HotelOS — fix: platform_admin no podía insertar en timeline_events al
-- crear un hotel (42501). La policy de INSERT de 0008 exigía membresía del
-- hotel (user_hotel_ids), pero quien crea el hotel es platform_admin y aún
-- no es miembro del hotel nuevo. El hotel se creaba y el evento
-- 'hotel.created' fallaba post-creación.
-- Fix: policy paralela para platform_admin (OR con la existente).

create policy "timeline_events_insert_platform_admin"
  on public.timeline_events for insert
  to authenticated
  with check (public.is_platform_admin());
