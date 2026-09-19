-- HotelOS — Hotel Demo: reset manual reproducible con ~7 semanas de historial.
--
-- Contexto (decisión acordada con el equipo): durante la fase de pruebas NO
-- hay reset automático — destruiría los datos que el equipo genera
-- explorando el sistema. El reset es un botón manual en /admin (tab "Demo").
-- Cuando la demo se vuelva pública, el mismo botón puede programarse como
-- cron (misma función; ver nota al final).
--
-- Qué hace public.reset_demo_hotel():
--   1. Asegura el hotel slug='hotel-demo' (lo crea si no existe) con licencia
--      sin límites y plan 'pro' (la demo muestra el producto completo).
--   2. Borra TODO el dato operativo de ese hotel (jamás toca otros hoteles
--      ni membresías: la cuenta demo sigue funcionando tras el reset).
--   3. Re-semea desde cero, con fechas ANCLADAS A current_date para que la
--      demo siempre se vea viva:
--        * ~35 estancias cerradas (checked_out) repartidas en 7 semanas
--          pasadas -> ocupación, ADR, revPAR, ingresos por día/semana/mes.
--        * 1 no-show, 2 cancelaciones (1 futura con reembolso).
--        * 3 estancias in-house con cargos extras y saldos parciales.
--        * 1 llegada registrada (arrived) y 4 reservas futuras (expected).
--        * solicitudes de huésped, incidencias y activos entregados.
--        * timeline_events real (reservation.created, checkin.completed,
--          payment.registered, checkout.completed...) -> KPIs con historia.
--
-- Seguridad:
--   * Sólo platform_admin (guard con is_platform_admin(), que lee auth.uid()
--     del JWT del llamador — el server action lo invoca con la sesión del
--     admin, nunca con service role).
--   * Corre como SECURITY DEFINER porque las tablas operativas no tienen
--     políticas de escritura para el cliente (convención 0022-0026).
--   * Es idempotente y atómico: un solo RPC = una transacción; si algo
--     falla, no queda a medias.
--   * Higiene de grants (regla dura del proyecto, ver auditoría M-1):
--     EXECUTE sólo para authenticated; revocado a public/anon.
--
-- Número 0050 a propósito: deja hueco a 0040 (ya aplicada) y a 0041/0042
-- que pueden existir en producción aunque aún no estén commiteadas.

-- ============================================================
-- reset_demo_hotel()
-- ============================================================
create or replace function public.reset_demo_hotel()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hotel_id uuid;
  v_rate numeric;
  v_total numeric;
  v_balance numeric;
  v_ci date;
  v_co date;
  v_room_id uuid;
  v_account_id uuid;
  v_stay_req_open uuid;
  v_stay_req_done uuid;
  v_stay_incident_open uuid;
  v_stay_incident_done uuid;
  v_stays_created integer;
  v_reservations_created integer;
  v_transactions_created integer;
  v_events_created integer;
begin
  set local statement_timeout = '60s';

  -- Guard: sólo staff de plataforma. auth.uid() viene del JWT del caller.
  if not public.is_platform_admin() then
    raise exception 'PERMISSION_DENIED: reset_demo_hotel requiere platform admin'
      using errcode = '42501';
  end if;

  -- ── 1. Hotel demo ────────────────────────────────────────────────────
  select id into v_hotel_id from public.hotels where slug = 'hotel-demo';
  if not found then
    insert into public.hotels (name, slug, plan, status, timezone, country)
    values ('Hotel Demo', 'hotel-demo', 'pro', 'active', 'America/Cancun', 'México')
    returning id into v_hotel_id;
    -- reception_settings y hotel_policies nacen por trigger (0020/0007).
  end if;

  insert into public.hotel_licenses (hotel_id, rooms_max, users_max, notes)
  values (v_hotel_id, null, null, 'Hotel Demo: sin límites ni vencimiento')
  on conflict (hotel_id) do nothing;

  insert into public.reception_settings (hotel_id)
  values (v_hotel_id)
  on conflict (hotel_id) do nothing;

  -- ── 2. Wipe (sólo el hotel demo; en orden hijo -> padre) ─────────────
  delete from public.stay_transactions where hotel_id = v_hotel_id;
  delete from public.stay_accounts    where hotel_id = v_hotel_id;
  delete from public.room_assignments where hotel_id = v_hotel_id;
  delete from public.guest_requests   where hotel_id = v_hotel_id;
  delete from public.stay_incidents   where hotel_id = v_hotel_id;
  delete from public.delivered_assets where hotel_id = v_hotel_id;
  delete from public.stays            where hotel_id = v_hotel_id;
  delete from public.reservation_stays where hotel_id = v_hotel_id;
  delete from public.reservations     where hotel_id = v_hotel_id;
  delete from public.inventory_holds  where hotel_id = v_hotel_id;
  delete from public.inventory_blocks where hotel_id = v_hotel_id;
  delete from public.quotes           where hotel_id = v_hotel_id;
  delete from public.leads            where hotel_id = v_hotel_id;
  delete from public.timeline_events  where hotel_id = v_hotel_id;
  delete from public.rooms            where hotel_id = v_hotel_id;
  delete from public.room_types       where hotel_id = v_hotel_id;

  insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, payload)
  values (v_hotel_id, 'platform', 'demo.reset', 'hotel', v_hotel_id,
          jsonb_build_object('reset_by', auth.uid()));

  -- ── 3. Catálogo: 4 tipos, 10 habitaciones ────────────────────────────
  insert into public.room_types (hotel_id, name, code, capacity_adults, capacity_children, accepts_pets)
  values
    (v_hotel_id, 'Sencilla',     'SEN', 2, 0, false),
    (v_hotel_id, 'Doble',        'DBL', 2, 1, true),
    (v_hotel_id, 'Junior Suite', 'JUN', 3, 2, true),
    (v_hotel_id, 'Master Suite', 'MAS', 4, 2, false);

  insert into public.rooms (hotel_id, room_type_id, code)
  select v_hotel_id, rt.id, v.code
  from (values
    ('101','SEN'), ('102','SEN'), ('103','SEN'), ('104','SEN'),
    ('201','DBL'), ('202','DBL'), ('203','DBL'),
    ('301','JUN'), ('302','MAS')
  ) as v(code, room_type)
  join public.room_types rt on rt.hotel_id = v_hotel_id and rt.code = v.room_type;

  -- ── 4. Spec del seed (fechas ancladas a current_date) ────────────────
  -- lifecycle: checked_out | no_show | in_house | arrived | expected
  create temporary table _demo_spec (
    folio     integer primary key,
    room_type text not null,
    room      text not null,
    guest     text not null,
    channel   text not null,
    ci_offset integer not null,  -- días respecto a current_date (negativo = pasado)
    nights    integer not null,
    adults    integer not null,
    children  integer not null,
    pets      boolean not null,
    lifecycle text not null
  ) on commit drop;

  insert into _demo_spec values
    -- Semanas -7 a -1: 35 estancias cerradas (la base de KPIs históricos)
    (1001, 'SEN', '101', 'Mariana Fuentes',        'direct',  -49, 2, 2, 0, false, 'checked_out'),
    (1002, 'DBL', '202', 'Rodrigo Cárdenas',       'booking', -48, 3, 2, 1, false, 'checked_out'),
    (1003, 'SEN', '102', 'Laura Jiménez',          'airbnb',  -47, 2, 1, 0, false, 'checked_out'),
    (1004, 'DBL', '201', 'Familia Ortega',         'direct',  -45, 4, 2, 2, false, 'checked_out'),
    (1005, 'MAS', '302', 'Grupo Meridian',         'expedia', -44, 2, 4, 0, false, 'checked_out'),
    (1006, 'SEN', '103', 'Pablo Villaseñor',       'walkin',  -42, 1, 1, 0, false, 'checked_out'),
    (1007, 'DBL', '203', 'Ana Sofía Ríos',         'booking', -41, 2, 2, 0, true,  'checked_out'),
    (1008, 'SEN', '104', 'Carmen Ibarra',          'direct',  -40, 2, 2, 0, false, 'checked_out'),
    (1009, 'DBL', '201', 'José Luis Camacho',      'phone',   -38, 3, 2, 1, false, 'checked_out'),
    (1010, 'JUN', '301', 'Familia Salgado',        'direct',  -37, 3, 3, 2, false, 'checked_out'),
    (1011, 'SEN', '101', 'Valeria Montes',         'booking', -35, 2, 1, 0, false, 'checked_out'),
    (1012, 'DBL', '202', 'Héctor y Lupita Vega',   'airbnb',  -34, 2, 2, 0, false, 'checked_out'),
    (1013, 'SEN', '102', 'Diego Fuentes',          'direct',  -33, 1, 2, 0, false, 'checked_out'),
    (1014, 'DBL', '203', 'Brenda Solís',           'expedia', -31, 2, 2, 1, false, 'checked_out'),
    (1015, 'SEN', '103', 'Mario Ontiveros',        'walkin',  -30, 2, 1, 0, false, 'checked_out'),
    (1016, 'SEN', '104', 'Alejandra Ponce',        'booking', -28, 2, 2, 0, false, 'checked_out'),
    (1017, 'DBL', '201', 'Familia Nájera',         'direct',  -27, 4, 2, 2, false, 'checked_out'),
    (1018, 'JUN', '301', 'Carlos Iriarte',         'phone',   -26, 2, 2, 0, true,  'checked_out'),
    (1019, 'SEN', '101', 'Fernanda Rosas',         'booking', -24, 3, 1, 0, false, 'checked_out'),
    (1020, 'DBL', '202', 'Rubén Aguilera',         'direct',  -23, 2, 2, 0, false, 'checked_out'),
    (1021, 'SEN', '102', 'Marcela Duarte',         'airbnb',  -21, 2, 2, 0, false, 'checked_out'),
    (1022, 'DBL', '203', 'Iván y Nora Salcedo',    'booking', -20, 2, 2, 1, false, 'checked_out'),
    (1023, 'SEN', '103', 'Julio César Lara',       'direct',  -19, 1, 1, 0, false, 'checked_out'),
    (1024, 'MAS', '302', 'Ejecutivos Andamio',     'expedia', -17, 2, 4, 0, false, 'checked_out'),
    (1025, 'DBL', '201', 'Ximena Herrera',         'direct',  -16, 3, 2, 1, false, 'checked_out'),
    (1026, 'SEN', '104', 'Óscar Mendieta',         'booking', -14, 2, 1, 0, false, 'checked_out'),
    (1027, 'DBL', '202', 'Familia Cabrera',        'airbnb',  -13, 3, 2, 2, false, 'checked_out'),
    (1028, 'SEN', '101', 'Renata Vidal',           'phone',   -12, 2, 2, 0, false, 'checked_out'),
    (1029, 'DBL', '203', 'Tomás Berlanga',         'booking', -11, 2, 2, 0, false, 'checked_out'),
    (1030, 'SEN', '102', 'Lucía Zamora',           'walkin',  -10, 1, 2, 0, false, 'checked_out'),
    (1031, 'JUN', '301', 'Daniela Osorio',         'direct',   -9, 2, 3, 0, false, 'checked_out'),
    (1032, 'SEN', '103', 'Martín Elizondo',        'booking',  -8, 2, 1, 0, false, 'checked_out'),
    (1033, 'DBL', '201', 'Gabriela y Saúl Prieto', 'direct',   -7, 2, 2, 0, false, 'checked_out'),
    (1034, 'SEN', '104', 'Hugo Serrano',           'airbnb',   -5, 2, 2, 0, false, 'checked_out'),
    (1035, 'DBL', '202', 'Alma Rentería',          'expedia',  -4, 2, 2, 1, false, 'checked_out'),
    -- Casos especiales del pasado
    (1036, 'SEN', '104', 'Paola Ibáñez',           'booking', -16, 2, 2, 0, false, 'no_show'),
    -- Presente: en casa, llegando hoy
    (1037, 'DBL', '202', 'Marisol y Emiliano Falcón', 'direct', -2, 4, 2, 1, false, 'in_house'),
    (1038, 'SEN', '101', 'Andrés Guillén',            'booking', -1, 3, 1, 0, false, 'in_house'),
    (1039, 'JUN', '301', 'Familia Quiroz',            'airbnb',  -1, 5, 3, 2, false, 'in_house'),
    (1040, 'SEN', '103', 'Perla Navarrete',           'walkin',   0, 1, 2, 0, false, 'arrived'),
    -- Futuro: llegadas próximas
    (1041, 'DBL', '201', 'Silvana Cordero',           'booking',  1, 2, 2, 0, false, 'expected'),
    (1042, 'SEN', '102', 'Ivonne y Pato Méndez',      'direct',   3, 2, 2, 0, false, 'expected'),
    (1043, 'DBL', '203', 'Ernesto Palacios',          'expedia',  6, 4, 2, 1, false, 'expected'),
    (1044, 'SEN', '104', 'Karla Benavides',           'phone',    8, 1, 1, 0, false, 'expected');

  -- Reservas (canceladas: sin estancia vendida, como en la vida real)
  insert into public.reservations (hotel_id, folio, primary_guest_name, primary_guest_email,
                                   primary_guest_phone, channel, status, cancelled_at,
                                   cancellation_reason, refund_amount, created_at)
  values
    (v_hotel_id, 'HD-2001', 'Nadia Treviño', 'nadia.trevino@example.com', '+52 998 4112233',
     'booking', 'cancelled', now() - interval '1 day', 'Huésped canceló por cambio de planes', 0,
     now() - interval '9 days'),
    (v_hotel_id, 'HD-2002', 'Grupo Kactus Eventos', 'reservas.grupo.kactus@example.com', '+52 998 5223344',
     'direct', 'cancelled', now() - interval '2 days', 'Reserva duplicada por el agente', 500,
     now() - interval '12 days');

  -- ── 5. Reservas + estancias vendidas (trigger crea stays y cuentas) ──
  insert into public.reservations (hotel_id, folio, primary_guest_name, primary_guest_email,
                                   primary_guest_phone, channel, status, created_at)
  select v_hotel_id,
         'HD-' || s.folio::text,
         s.guest,
         translate(lower(replace(s.guest, ' ', '.')), 'áéíóúñü', 'aeiounu') || '@example.com',
         '+52 998 ' || lpad((3200000 + s.folio)::text, 7, '0'),
         s.channel,
         case when s.lifecycle = 'no_show' then 'no_show' else 'confirmed' end,
         current_date + s.ci_offset - 14
  from _demo_spec s;

  insert into public.reservation_stays (hotel_id, reservation_id, room_type_id, check_in, check_out,
                                        adults, children, has_pets, rate_total, created_at)
  select v_hotel_id, r.id, rt.id,
         current_date + s.ci_offset,
         current_date + s.ci_offset + s.nights,
         s.adults, s.children, s.pets,
         s.nights * case s.room_type when 'SEN' then 1150 when 'DBL' then 1750
                                     when 'JUN' then 2500 else 3300 end,
         current_date + s.ci_offset - 14
  from _demo_spec s
  join public.reservations r on r.hotel_id = v_hotel_id and r.folio = 'HD-' || s.folio::text
  join public.room_types rt on rt.hotel_id = v_hotel_id and rt.code = s.room_type;

  -- ── 6. Ciclo de vida por estancia ────────────────────────────────────
  for rec in
    select st.id as stay_id, r.id as reservation_id, r.folio, s.*
    from _demo_spec s
    join public.reservations r      on r.hotel_id = v_hotel_id and r.folio = 'HD-' || s.folio::text
    join public.reservation_stays rs on rs.reservation_id = r.id
    join public.stays st            on st.reservation_stay_id = rs.id
    order by s.folio
  loop
    v_ci := current_date + rec.ci_offset;
    v_co := v_ci + rec.nights;
    v_rate := case rec.room_type when 'SEN' then 1150 when 'DBL' then 1750
                                 when 'JUN' then 2500 else 3300 end;
    v_total := rec.nights * v_rate;

    select id into v_room_id from public.rooms where hotel_id = v_hotel_id and code = rec.room;
    select id into v_account_id from public.stay_accounts where stay_id = rec.stay_id;

    -- Timeline: reserva creada
    insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
    values (v_hotel_id, 'reservations', 'reservation.created', 'reservation', rec.reservation_id, v_ci - 14);

    -- Anticipo garantía (30%) en la confirmación
    insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
    values (v_hotel_id, v_account_id, 'payment', -round(v_total * 0.3, 2), 'Anticipo garantía', 'transfer', v_ci - 14);
    insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
    values (v_hotel_id, 'front_desk', 'payment.registered', 'stay', rec.stay_id, v_ci - 14);

    if rec.lifecycle = 'checked_out' then
      update public.stays
      set status = 'checked_out',
          arrived_at = (v_ci + time '14:35')::timestamptz,
          checked_in_at = (v_ci + time '15:20')::timestamptz,
          in_house_at = (v_ci + time '16:05')::timestamptz,
          checked_out_at = (v_co + time '11:30')::timestamptz
      where id = rec.stay_id;

      insert into public.room_assignments (hotel_id, stay_id, room_id, assigned_at, released_at)
      values (v_hotel_id, rec.stay_id, v_room_id,
              (v_ci + time '15:20')::timestamptz, (v_co + time '11:30')::timestamptz);

      -- Cargo principal del hospedaje
      insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
      values (v_hotel_id, v_account_id, 'charge', v_total,
              'Hospedaje ' || rec.nights || ' noche(s) ' || rec.room_type,
              null, (v_ci + time '16:05')::timestamptz);

      -- Extras en una de cada cuatro estancias cerradas
      if rec.folio % 4 = 1 then
        insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
        values (v_hotel_id, v_account_id, 'charge', 350, 'Consumo minibar', null, (v_ci + 1 + time '21:10')::timestamptz);
      end if;

      -- Liquidación al check-out (cobro exacto del saldo restante)
      select balance into v_balance from public.stay_accounts where id = v_account_id;
      insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
      values (v_hotel_id, v_account_id, 'payment', -v_balance, 'Liquidación al check-out',
              case when rec.folio % 2 = 0 then 'card' else 'cash' end,
              (v_co + time '11:30')::timestamptz);
      insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
      values (v_hotel_id, 'front_desk', 'payment.registered', 'stay', rec.stay_id, (v_co + time '11:30')::timestamptz);

      update public.stay_accounts set status = 'closed', closed_at = (v_co + time '11:30')::timestamptz
      where id = v_account_id;
      update public.reservations set status = 'completed' where id = rec.reservation_id;

      insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
      values (v_hotel_id, 'front_desk', 'checkin.completed', 'stay', rec.stay_id, (v_ci + time '15:20')::timestamptz);
      insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
      values (v_hotel_id, 'front_desk', 'checkout.completed', 'stay', rec.stay_id, (v_co + time '11:30')::timestamptz);

    elsif rec.lifecycle = 'no_show' then
      update public.stays
      set status = 'no_show',
          no_show_at = (v_ci + 1 + time '12:00')::timestamptz,
          no_show_reason = 'No se presentó'
      where id = rec.stay_id;

      insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
      values (v_hotel_id, v_account_id, 'charge', v_rate, 'Penalización no-show (una noche)', null,
              (v_ci + 1 + time '12:00')::timestamptz);

      insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
      values (v_hotel_id, 'front_desk', 'no_show.marked', 'stay', rec.stay_id, (v_ci + 1 + time '12:00')::timestamptz);

    elsif rec.lifecycle = 'in_house' then
      update public.stays
      set status = 'in_house',
          arrived_at = (v_ci + time '14:10')::timestamptz,
          checked_in_at = (v_ci + time '15:05')::timestamptz,
          in_house_at = (v_ci + time '15:50')::timestamptz
      where id = rec.stay_id;

      insert into public.room_assignments (hotel_id, stay_id, room_id, assigned_at)
      values (v_hotel_id, rec.stay_id, v_room_id, (v_ci + time '15:05')::timestamptz);

      insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
      values (v_hotel_id, v_account_id, 'charge', v_total,
              'Hospedaje ' || rec.nights || ' noche(s) ' || rec.room_type,
              null, (v_ci + time '15:50')::timestamptz);

      -- Extras y abonos según el folio (dejan saldos distintos: "cobrar_saldo")
      if rec.folio = 1037 then
        insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
        values (v_hotel_id, v_account_id, 'charge', 520, 'Restaurante', null, now() - interval '8 hours'),
               (v_hotel_id, v_account_id, 'charge', 320, 'Consumo minibar', null, now() - interval '3 hours');
        insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
        values (v_hotel_id, v_account_id, 'payment', -1000, 'Abono a cuenta', 'card', now() - interval '5 hours');
        insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
        values (v_hotel_id, 'front_desk', 'payment.registered', 'stay', rec.stay_id, now() - interval '5 hours');
      elsif rec.folio = 1038 then
        insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
        values (v_hotel_id, v_account_id, 'charge', 280, 'Consumo minibar', null, now() - interval '2 hours');
      elsif rec.folio = 1039 then
        insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
        values (v_hotel_id, v_account_id, 'charge', 640, 'Restaurante', null, now() - interval '10 hours'),
               (v_hotel_id, v_account_id, 'charge', 260, 'Lavandería', null, now() - interval '6 hours');
        insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_at)
        values (v_hotel_id, v_account_id, 'payment', -2000, 'Abono a cuenta', 'transfer', now() - interval '4 hours');
        insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
        values (v_hotel_id, 'front_desk', 'payment.registered', 'stay', rec.stay_id, now() - interval '4 hours');
      end if;

      insert into public.timeline_events (hotel_id, module, event_type, entity_type, entity_id, occurred_at)
      values (v_hotel_id, 'front_desk', 'checkin.completed', 'stay', rec.stay_id, (v_ci + time '15:05')::timestamptz);

    elsif rec.lifecycle = 'arrived' then
      update public.stays
      set status = 'arrived', arrived_at = (current_date + time '10:45')::timestamptz
      where id = rec.stay_id;
    end if;

    -- Captura de estancias para solicitudes/incidencias/activos (abajo)
    if rec.folio = 1037 then v_stay_req_open := rec.stay_id; v_stay_incident_done := null; end if;
    if rec.folio = 1017 then v_stay_req_done := rec.stay_id; end if;
    if rec.folio = 1038 then v_stay_incident_open := rec.stay_id; end if;
    if rec.folio = 1002 then v_stay_incident_done := rec.stay_id; end if;

    -- Materializa next_action (patrón del proyecto: nunca calculado al leer)
    perform public.recompute_stay_next_action(rec.stay_id);
  end loop;

  -- ── 7. Solicitudes, incidencias y activos ────────────────────────────
  -- Activos: llaves (y control TV en tipos no-Sencilla) devueltos en
  -- estancias cerradas; entregados y SIN devolver en las 3 in-house.
  insert into public.delivered_assets (hotel_id, stay_id, asset_name, delivered, delivered_at, returned, returned_at)
  select v_hotel_id, st.id, 'Llaves', true, st.checked_in_at, true, st.checked_out_at
  from public.stays st where st.hotel_id = v_hotel_id and st.status = 'checked_out';

  insert into public.delivered_assets (hotel_id, stay_id, asset_name, delivered, delivered_at, returned, returned_at)
  select v_hotel_id, st.id, 'Control TV', true, st.checked_in_at, true, st.checked_out_at
  from public.stays st
  join public.reservation_stays rs on rs.id = st.reservation_stay_id
  join public.room_types rt on rt.id = rs.room_type_id
  where st.hotel_id = v_hotel_id and st.status = 'checked_out' and rt.code <> 'SEN';

  insert into public.delivered_assets (hotel_id, stay_id, asset_name, delivered, delivered_at, returned, returned_at)
  select v_hotel_id, id, 'Llaves', true, checked_in_at, false, null
  from public.stays where hotel_id = v_hotel_id and status = 'in_house';

  insert into public.delivered_assets (hotel_id, stay_id, asset_name, delivered, delivered_at, returned, returned_at)
  select v_hotel_id, st.id, 'Control TV', true, st.checked_in_at, false, null
  from public.stays st
  join public.reservation_stays rs on rs.id = st.reservation_stay_id
  join public.room_types rt on rt.id = rs.room_type_id
  where st.hotel_id = v_hotel_id and st.status = 'in_house' and rt.code <> 'SEN';

  -- Solicitudes del huésped (una en progreso, una resuelta)
  if v_stay_req_open is not null then
    insert into public.guest_requests (hotel_id, stay_id, description, status, created_at)
    values (v_hotel_id, v_stay_req_open, 'Toallas extra para la habitación', 'in_progress', now() - interval '3 hours');
  end if;
  if v_stay_req_done is not null then
    insert into public.guest_requests (hotel_id, stay_id, description, status, resolved_at, created_at)
    values (v_hotel_id, v_stay_req_done, 'Despertador 6:30 AM', 'completed',
            (select checked_in_at + interval '20 minutes' from public.stays where id = v_stay_req_done),
            (select checked_in_at from public.stays where id = v_stay_req_done));
  end if;

  -- Incidencias (una abierta que bloquea el check-out de esa estancia,
  -- una resuelta hace semanas)
  if v_stay_incident_open is not null then
    insert into public.stay_incidents (hotel_id, stay_id, room_id, type, severity, description, status, created_at)
    select v_hotel_id, v_stay_incident_open, ra.room_id, 'maintenance', 'medium',
           'Fuga ligera en el lavabo del baño', 'open', now() - interval '6 hours'
    from public.room_assignments ra where ra.stay_id = v_stay_incident_open and ra.released_at is null;
  end if;
  if v_stay_incident_done is not null then
    insert into public.stay_incidents (hotel_id, stay_id, room_id, type, severity, description, status, resolved_at, created_at)
    select v_hotel_id, v_stay_incident_done, ra.room_id, 'maintenance', 'low',
           'Aire acondicionado con ruido', 'resolved',
           st.checked_in_at + interval '1 day', st.checked_in_at + interval '2 hours'
    from public.stays st
    join public.room_assignments ra on ra.stay_id = st.id and ra.released_at is null
    where st.id = v_stay_incident_done;
  end if;

  -- ── 8. Limpieza coherente con ocupación actual ───────────────────────
  update public.rooms set is_clean = true where hotel_id = v_hotel_id;
  update public.rooms set is_clean = false
  where hotel_id = v_hotel_id
    and id in (select room_id from public.room_assignments
               where hotel_id = v_hotel_id and released_at is null);

  -- ── 9. Resumen ───────────────────────────────────────────────────────
  select count(*) into v_stays_created
    from public.stays where hotel_id = v_hotel_id;
  select count(*) into v_reservations_created
    from public.reservations where hotel_id = v_hotel_id;
  select count(*) into v_transactions_created
    from public.stay_transactions where hotel_id = v_hotel_id;
  select count(*) into v_events_created
    from public.timeline_events where hotel_id = v_hotel_id and event_type <> 'demo.reset';

  return jsonb_build_object(
    'hotel_id', v_hotel_id,
    'hotel_slug', 'hotel-demo',
    'stays_created', v_stays_created,
    'reservations_created', v_reservations_created,
    'transactions_created', v_transactions_created,
    'timeline_events_created', v_events_created,
    'reset_at', now()
  );
end;
$$;

comment on function public.reset_demo_hotel() is
  'Borra y regenera el Hotel Demo (slug hotel-demo) con ~7 semanas de historial realista. Sólo platform_admin. Idempotente y atómico.';

-- Higiene de grants (auditoría M-1): EXECUTE sólo para authenticated.
revoke execute on function public.reset_demo_hotel() from public, anon;
grant execute on function public.reset_demo_hotel() to authenticated;
