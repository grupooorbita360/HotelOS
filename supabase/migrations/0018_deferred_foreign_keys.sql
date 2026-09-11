-- HotelOS / Reservaciones: FKs que no se pudieron declarar antes porque la
-- tabla referenciada (public.reservations) todavia no existia.

alter table public.leads
  add constraint leads_reservation_id_fkey
  foreign key (reservation_id) references public.reservations (id);

alter table public.inventory_holds
  add constraint inventory_holds_converted_reservation_id_fkey
  foreign key (converted_reservation_id) references public.reservations (id);
