-- HotelOS / Caja (Modulo 06): control del movimiento real de dinero.
--
-- Principio de propietarios: Reservaciones = que se debe cobrar. Recepcion
-- = cuando debe pagar. Caja = que movimiento REAL de dinero ocurrio.
--
-- Decisiones cerradas (no reabrir sin pedirlo explicitamente):
-- 1) CuentaFolio/MovimientoCuenta YA es stay_accounts/stay_transactions
--    (0024). No se crea tabla paralela: se extiende su catalogo de `type`
--    (agrega 'adjustment') y se le agrega un trigger que alimenta
--    cash_movements cuando el metodo es efectivo.
-- 2) payments (0017) se extiende, no se reemplaza: gana payment_method_id
--    (catalogo configurable payment_methods) y estados nuevos en su CHECK.
--    method/su CHECK original quedan intactos por compatibilidad con
--    registerPayment() de Reservaciones, que no se toca.
-- 3) PermisoExcepcion NO se construye aqui -- decision temporal: reembolsos
--    y ajustes usan has_permission() simple (cash.refund/cash.adjust).
--    Cuando exista PermisoExcepcion (modulo transversal futuro), estas dos
--    acciones deben conectarse a el.
-- 4) cash_shifts + cash_movements son lo unico genuinamente nuevo (TurnoCaja).

-- ============================================================
-- 1) hotels.moneda_base
-- ============================================================
alter table public.hotels
  add column moneda_base text not null default 'MXN';

comment on column public.hotels.moneda_base is
  'Moneda de operacion del hotel. payments.currency puede diferir (pago en moneda extranjera); amount_local siempre esta en esta moneda.';

-- ============================================================
-- 2) cash_settings (config de Caja por hotel, mismo patron que
--    reception_settings/hotel_policies)
-- ============================================================
create table public.cash_settings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,

  usa_turnos_caja boolean not null default true,
  requiere_facturacion_fiscal boolean not null default false,

  -- Datos fiscales minimos; el timbrado real se delega a un PAC externo
  -- (integracion futura, fuera de alcance de esta sesion).
  rfc_hotel text,
  regimen_fiscal text,

  extra_settings jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.cash_settings is
  'Configuracion de Caja por hotel: si usa turnos de efectivo y si requiere datos fiscales. Una fila por hotel, creada automaticamente al dar de alta el hotel.';

create trigger trg_cash_settings_audit
  before insert or update on public.cash_settings
  for each row execute function public.set_audit_fields();

create or replace function public.handle_new_hotel_cash_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cash_settings (hotel_id) values (new.id);
  return new;
end;
$$;

revoke execute on function public.handle_new_hotel_cash_settings() from public;

create trigger trg_on_hotel_created_cash_settings
  after insert on public.hotels
  for each row execute function public.handle_new_hotel_cash_settings();

alter table public.cash_settings enable row level security;

create policy "cash_settings_select_member_or_platform_admin"
  on public.cash_settings for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "cash_settings_write_settings_manager_or_platform_admin"
  on public.cash_settings for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

insert into public.cash_settings (hotel_id)
select id from public.hotels
on conflict (hotel_id) do nothing;

-- ============================================================
-- 3) payment_methods (CAT_METODOS_PAGO configurable por hotel)
-- ============================================================
create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  name text not null,
  -- Clasificacion base: determina si cuenta como efectivo para TurnoCaja.
  type text not null check (type in ('cash', 'card', 'transfer', 'other')),
  is_active boolean not null default true,

  requiere_referencia boolean not null default false,
  requiere_autorizacion boolean not null default false,
  requiere_terminal boolean not null default false,
  permite_moneda_extranjera boolean not null default false,
  requiere_validacion_manual boolean not null default false,
  genera_comision boolean not null default false,
  proveedor text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, name)
);

comment on table public.payment_methods is
  'Catalogo de metodos de pago por hotel. Cortesia nunca es un metodo de pago aqui -- es un descuento via has_permission(), no hubo dinero real. genera_comision es informativo para Finanzas/reconciliacion (v2): nunca afecta el saldo del huesped salvo que el hotel decida trasladarla como cargo explicito.';

create trigger trg_payment_methods_audit
  before insert or update on public.payment_methods
  for each row execute function public.set_audit_fields();

create or replace function public.handle_new_hotel_payment_methods()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payment_methods (hotel_id, name, type, requiere_referencia)
  values
    (new.id, 'Tarjeta', 'card', false),
    (new.id, 'Transferencia', 'transfer', true);
  return new;
end;
$$;

revoke execute on function public.handle_new_hotel_payment_methods() from public;

create trigger trg_on_hotel_created_payment_methods
  after insert on public.hotels
  for each row execute function public.handle_new_hotel_payment_methods();

alter table public.payment_methods enable row level security;

create policy "payment_methods_select_member_or_platform_admin"
  on public.payment_methods for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "payment_methods_write_settings_manager_or_platform_admin"
  on public.payment_methods for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

-- Backfill: hoteles existentes, matching a los dos valores legacy de
-- payments.method ('card','transfer') para poder mapear pagos historicos.
insert into public.payment_methods (hotel_id, name, type, requiere_referencia)
select h.id, 'Tarjeta', 'card', false
from public.hotels h
where not exists (select 1 from public.payment_methods pm where pm.hotel_id = h.id and pm.type = 'card');

insert into public.payment_methods (hotel_id, name, type, requiere_referencia)
select h.id, 'Transferencia', 'transfer', true
from public.hotels h
where not exists (select 1 from public.payment_methods pm where pm.hotel_id = h.id and pm.type = 'transfer');

-- ============================================================
-- 4) payments: extension aditiva (payment_method_id + estados nuevos)
--    method/su CHECK quedan intactos -- registerPayment() de Reservaciones
--    (src/modules/reservaciones/actions/payment.ts) no se toca ni se rompe.
-- ============================================================
alter table public.payments
  add column payment_method_id uuid references public.payment_methods (id);

comment on column public.payments.payment_method_id is
  'FK al catalogo configurable payment_methods (Caja, 0046). Nullable: pagos insertados por Reservaciones via registerPayment() (metodo legacy card/transfer en texto) pueden no traerlo. Nuevos pagos registrados desde Caja (register_payment_with_movements) siempre lo fijan.';

-- Backfill de pagos existentes: matching por hotel_id + method -> type.
update public.payments p
set payment_method_id = pm.id
from public.payment_methods pm
where p.payment_method_id is null
  and pm.hotel_id = p.hotel_id
  and pm.type = p.method;

-- Amplia el catalogo cerrado de method (antes solo 'card'/'transfer' --
-- demasiado angosto para aceptar efectivo, que es un metodo central de
-- este modulo). Superset seguro: los dos valores legacy siguen siendo
-- validos: registerPayment() de Reservaciones (metodo "card"|"transfer" en
-- su tipo de TS) nunca manda otra cosa, asi que no se rompe nada existente.
do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.payments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%method%card%transfer%';

  if v_conname is not null then
    execute format('alter table public.payments drop constraint %I', v_conname);
  end if;

  alter table public.payments
    add constraint payments_method_check
    check (method in ('cash', 'card', 'transfer', 'other'));
end $$;

-- Amplia el catalogo cerrado de estados (PENDIENTE=pending, APLICADO=
-- completed [ya existia, se reusa], RECHAZADO=rejected, ANULADO=voided,
-- REVERSADO=reversed, EN_VALIDACION=pending_validation). Check anonimo
-- (0017): se localiza por catalogo, no se asume nombre autogenerado
-- (mismo patron que 0033).
do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.payments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';

  if v_conname is not null then
    execute format('alter table public.payments drop constraint %I', v_conname);
  end if;

  alter table public.payments
    add constraint payments_status_check
    check (status in ('pending', 'completed', 'rejected', 'reversed', 'voided', 'pending_validation'));
end $$;

-- ============================================================
-- 5) payment_movements: 1 Pago -> N MovimientoCaja. Sin INSERT/UPDATE de
--    cliente (mismo patron que inventory_blocks/reservations): solo se
--    escribe desde register_payment_with_movements()/register_refund().
-- ============================================================
create table public.payment_movements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  payment_id uuid not null references public.payments (id) on delete cascade,
  payment_method_id uuid not null references public.payment_methods (id),

  -- Mismo signo que payments.amount del pago padre (positivo=cobro,
  -- negativo=reembolso) -- la suma de los movimientos de un pago siempre
  -- iguala payments.amount.
  amount numeric(12, 2) not null,
  reference text,

  validated_at timestamptz,
  validated_by uuid references auth.users (id),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

comment on table public.payment_movements is
  'MovimientoCaja: el movimiento real de dinero por metodo dentro de un Pago. Un pago de $3,000 dividido en $2,000 tarjeta + $1,000 efectivo es UN payments + DOS payment_movements. Append-only (sin updated_at/updated_by): created_by lo fija la funcion SECURITY DEFINER, nunca un trigger generico (regla 11 CLAUDE.md).';

create index idx_payment_movements_payment on public.payment_movements (payment_id);

alter table public.payment_movements enable row level security;

create policy "payment_movements_select_member_or_platform_admin"
  on public.payment_movements for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- ============================================================
-- 6) stay_transactions: agrega 'adjustment' al catalogo de type (check
--    anonimo de 0024, mismo patron de localizar por catalogo que arriba).
--    register_stay_transaction()/void_stay_transaction() (0026) NO se
--    tocan -- nunca emiten 'adjustment' (su propia validacion de signo
--    solo conoce charge/payment/refund); el unico camino para insertar
--    una fila 'adjustment' es la funcion nueva register_stay_adjustment().
-- ============================================================
-- Dos checks anonimos distintos mencionan charge/payment/refund a la vez
-- (el de type solo, y el cruzado con amount) -- se desambiguan exigiendo
-- (o excluyendo) 'amount' en la definicion, nunca se asume un nombre
-- autogenerado (misma cautela que 0033: el nombre real puede no coincidir
-- entre local y Supabase).
do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.stay_transactions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%charge%'
    and pg_get_constraintdef(oid) ilike '%amount%';

  if v_conname is not null then
    execute format('alter table public.stay_transactions drop constraint %I', v_conname);
  end if;

  alter table public.stay_transactions
    add constraint stay_transactions_type_amount_check
    check (
      (type in ('charge', 'refund') and amount > 0)
      or (type = 'payment' and amount < 0)
      or (type = 'adjustment' and amount <> 0)
    );
end $$;

do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.stay_transactions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%charge%'
    and pg_get_constraintdef(oid) not ilike '%amount%';

  if v_conname is not null then
    execute format('alter table public.stay_transactions drop constraint %I', v_conname);
  end if;

  alter table public.stay_transactions
    add constraint stay_transactions_type_check
    check (type in ('charge', 'payment', 'refund', 'adjustment'));
end $$;

-- ============================================================
-- 7) cash_shifts (TurnoCaja) + cash_movements
-- ============================================================
create table public.cash_shifts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  status text not null default 'open' check (status in ('open', 'closed')),

  fondo_inicial numeric(12, 2) not null default 0,
  opened_at timestamptz not null default now(),
  opened_by uuid references auth.users (id),

  efectivo_contado numeric(12, 2),
  efectivo_esperado numeric(12, 2),
  diferencia numeric(12, 2),
  closed_at timestamptz,
  closed_by uuid references auth.users (id),

  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.cash_shifts is
  'TurnoCaja: el periodo/caja fisica, no el usuario. Varios usuarios pueden cobrar en el mismo turno -- cada cash_movement conserva su propio created_by. Sin INSERT/UPDATE de cliente: solo via open_cash_shift()/close_cash_shift().';

create trigger trg_cash_shifts_audit
  before insert or update on public.cash_shifts
  for each row execute function public.set_audit_fields();

-- Un solo turno abierto por hotel a la vez.
create unique index idx_cash_shifts_one_open_per_hotel
  on public.cash_shifts (hotel_id)
  where status = 'open';

alter table public.cash_shifts enable row level security;

create policy "cash_shifts_select_member_or_platform_admin"
  on public.cash_shifts for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  cash_shift_id uuid not null references public.cash_shifts (id),

  -- Direccion real del efectivo. cash_in suma a EfectivoEsperado,
  -- cash_out resta (EfectivoDevuelto/reembolsos en efectivo y
  -- EgresosAutorizados son ambos cash_out, distinguidos por source).
  type text not null check (type in ('cash_in', 'cash_out')),
  source text not null check (source in ('payment', 'stay_transaction', 'operational_expense')),

  amount numeric(12, 2) not null check (amount > 0),
  concept text not null,
  category text,
  receipt_url text,

  payment_movement_id uuid references public.payment_movements (id),
  stay_transaction_id uuid references public.stay_transactions (id),
  authorized_by uuid references auth.users (id),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  check (
    (source = 'payment' and payment_movement_id is not null and stay_transaction_id is null)
    or (source = 'stay_transaction' and stay_transaction_id is not null and payment_movement_id is null)
    or (source = 'operational_expense' and payment_movement_id is null and stay_transaction_id is null)
  )
);

comment on table public.cash_movements is
  'Efectivo real que entra/sale de un TurnoCaja. Fuente unica para calcular EfectivoEsperado -- nunca se deriva de payment_movements/stay_transactions por separado en dos lugares (regla 6: no duplicar). Se llena solo (a) automaticamente cuando un payment_movement/stay_transaction en efectivo ocurre con un turno abierto, o (b) via register_cash_expense() para egresos operativos. Sin INSERT directo del cliente.';

create index idx_cash_movements_shift on public.cash_movements (cash_shift_id);

alter table public.cash_movements enable row level security;

create policy "cash_movements_select_member_or_platform_admin"
  on public.cash_movements for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- ============================================================
-- 8) Trigger: stay_transactions en efectivo -> cash_movements.
--    Best-effort, nunca bloquea a Recepcion: si no hay turno abierto o el
--    hotel no usa turnos, simplemente no genera el movimiento (no revienta
--    register_stay_transaction()/void_stay_transaction(), que Recepcion
--    sigue necesitando funcionar sin depender del estado de Caja).
-- ============================================================
create or replace function public.handle_cash_stay_transaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usa_turnos boolean;
  v_shift_id uuid;
begin
  if new.method <> 'cash' or new.type not in ('payment', 'refund') then
    return new;
  end if;

  select usa_turnos_caja into v_usa_turnos
  from public.cash_settings where hotel_id = new.hotel_id;
  if not coalesce(v_usa_turnos, true) then
    return new;
  end if;

  select id into v_shift_id
  from public.cash_shifts
  where hotel_id = new.hotel_id and status = 'open';
  if v_shift_id is null then
    return new;
  end if;

  insert into public.cash_movements (
    hotel_id, cash_shift_id, type, source, amount, concept, stay_transaction_id, created_by
  ) values (
    new.hotel_id, v_shift_id,
    case when new.type = 'payment' then 'cash_in' else 'cash_out' end,
    'stay_transaction', abs(new.amount), new.concept, new.id, auth.uid()
  );

  return new;
end;
$$;

revoke execute on function public.handle_cash_stay_transaction() from public;

create trigger trg_stay_transaction_cash_movement
  after insert on public.stay_transactions
  for each row execute function public.handle_cash_stay_transaction();

-- ============================================================
-- 9) Permisos nuevos: cash.refund, cash.adjust.
-- ============================================================
insert into public.permissions (code, module, description) values
  ('cash.refund', 'billing', 'Registrar un reembolso'),
  ('cash.adjust', 'billing', 'Registrar un ajuste manual de saldo')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'hotel_admin' and r.hotel_id is null and p.code in ('cash.refund', 'cash.adjust')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('cash.refund', 'cash.adjust')
where r.name = 'accounting' and r.hotel_id is null
on conflict do nothing;

-- ============================================================
-- 10) register_payment_with_movements(): 1 Pago -> N MovimientoCaja,
--     atomico. Sobrepago nunca se acepta en silencio (p_confirm_overpayment).
--     "Saldo" aqui = lo vendido en la reserva (reservation_stays.rate_total)
--     menos lo ya pagado -- el unico saldo que existe a nivel Reservacion
--     (stay_accounts.balance es otro saldo, el de Recepcion, ver 0024).
-- ============================================================
create or replace function public.register_payment_with_movements(
  p_hotel_id uuid,
  p_reservation_id uuid,
  p_type text,
  p_movements jsonb,
  p_currency text default 'MXN',
  p_notes text default null,
  p_confirm_overpayment boolean default false
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
  v_movement jsonb;
  v_method public.payment_methods;
  v_total_amount numeric := 0;
  v_needs_validation boolean := false;
  v_status text := 'completed';
  v_total_vendido numeric;
  v_ya_pagado numeric;
  v_saldo_antes numeric;
  v_first_method_id uuid;
  v_first_method_type text;
  v_payment public.payments;
  v_shift_id uuid;
  v_usa_turnos boolean;
  v_movement_id uuid;
begin
  if not public.has_permission(p_hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;

  select * into v_reservation from public.reservations where id = p_reservation_id;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_reservation.hotel_id <> p_hotel_id then raise exception 'RESERVATION_NOT_IN_HOTEL'; end if;

  if p_type not in ('deposit', 'installment', 'full_payment') then
    raise exception 'INVALID_TYPE: %', p_type;
  end if;

  if p_movements is null or jsonb_array_length(p_movements) = 0 then
    raise exception 'NO_MOVEMENTS';
  end if;

  for v_movement in select * from jsonb_array_elements(p_movements)
  loop
    if (v_movement ->> 'amount')::numeric <= 0 then
      raise exception 'INVALID_MOVEMENT_AMOUNT';
    end if;

    select * into v_method from public.payment_methods
    where id = (v_movement ->> 'payment_method_id')::uuid and hotel_id = p_hotel_id and is_active;
    if not found then raise exception 'PAYMENT_METHOD_NOT_FOUND_FOR_HOTEL'; end if;

    if v_method.requiere_referencia and coalesce(v_movement ->> 'reference', '') = '' then
      raise exception 'REFERENCE_REQUIRED: % requiere referencia', v_method.name;
    end if;
    if v_method.requiere_validacion_manual then
      v_needs_validation := true;
    end if;
    if v_first_method_id is null then
      v_first_method_id := v_method.id;
      v_first_method_type := v_method.type;
    end if;

    v_total_amount := v_total_amount + (v_movement ->> 'amount')::numeric;
  end loop;

  select coalesce(sum(rs.rate_total), 0) into v_total_vendido
  from public.reservation_stays rs where rs.reservation_id = p_reservation_id;
  select coalesce(sum(amount), 0) into v_ya_pagado
  from public.payments where reservation_id = p_reservation_id and status not in ('rejected', 'voided');
  v_saldo_antes := v_total_vendido - v_ya_pagado;

  if v_total_amount > v_saldo_antes and not p_confirm_overpayment then
    raise exception 'OVERPAYMENT_CONFIRMATION_REQUIRED: saldo_pendiente=% monto_intentado=%', v_saldo_antes, v_total_amount
      using errcode = 'P0001';
  end if;

  if v_needs_validation then
    v_status := 'pending_validation';
  end if;

  insert into public.payments (
    hotel_id, reservation_id, type, amount, currency, amount_local,
    method, status, payment_method_id, notes
  ) values (
    p_hotel_id, p_reservation_id, p_type, v_total_amount, p_currency, v_total_amount,
    v_first_method_type, v_status, v_first_method_id, p_notes
  ) returning * into v_payment;

  select usa_turnos_caja into v_usa_turnos from public.cash_settings where hotel_id = p_hotel_id;
  select id into v_shift_id from public.cash_shifts where hotel_id = p_hotel_id and status = 'open';

  for v_movement in select * from jsonb_array_elements(p_movements)
  loop
    select * into v_method from public.payment_methods where id = (v_movement ->> 'payment_method_id')::uuid;

    insert into public.payment_movements (
      hotel_id, payment_id, payment_method_id, amount, reference, created_by
    ) values (
      p_hotel_id, v_payment.id, v_method.id, (v_movement ->> 'amount')::numeric,
      nullif(v_movement ->> 'reference', ''), auth.uid()
    ) returning id into v_movement_id;

    if v_method.type = 'cash' then
      if coalesce(v_usa_turnos, true) and v_shift_id is null then
        raise exception 'NO_OPEN_CASH_SHIFT: abre un turno de caja antes de cobrar en efectivo';
      end if;
      if v_shift_id is not null then
        insert into public.cash_movements (
          hotel_id, cash_shift_id, type, source, amount, concept, payment_movement_id, created_by
        ) values (
          p_hotel_id, v_shift_id, 'cash_in', 'payment', (v_movement ->> 'amount')::numeric,
          'Pago ' || p_type || ' -- reserva ' || v_reservation.folio,
          v_movement_id, auth.uid()
        );
      end if;
    end if;
  end loop;

  return v_payment;
end;
$$;

revoke execute on function public.register_payment_with_movements(uuid, uuid, text, jsonb, text, text, boolean) from public;
grant execute on function public.register_payment_with_movements(uuid, uuid, text, jsonb, text, text, boolean) to authenticated;

-- ============================================================
-- 11) register_refund(): reembolso nunca es un monto negativo en la
--     entrada del usuario (p_amount siempre positivo) -- internamente se
--     guarda como payments.amount negativo, mismo signo que la garantia de
--     0017 ya exige para type='refund' (check original, sin tocar).
-- ============================================================
create or replace function public.register_refund(
  p_hotel_id uuid,
  p_reservation_id uuid,
  p_original_payment_id uuid,
  p_amount numeric,
  p_payment_method_id uuid,
  p_reason text
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
  v_original public.payments;
  v_method public.payment_methods;
  v_payment public.payments;
  v_shift_id uuid;
  v_usa_turnos boolean;
  v_movement_id uuid;
begin
  if not public.has_permission(p_hotel_id, 'cash.refund') then
    raise exception 'PERMISSION_DENIED: cash.refund required' using errcode = '42501';
  end if;

  select * into v_reservation from public.reservations where id = p_reservation_id;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_reservation.hotel_id <> p_hotel_id then raise exception 'RESERVATION_NOT_IN_HOTEL'; end if;

  if p_amount <= 0 then raise exception 'INVALID_AMOUNT: el monto del reembolso debe ser positivo'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'REASON_REQUIRED'; end if;

  if p_original_payment_id is not null then
    select * into v_original from public.payments where id = p_original_payment_id;
    if not found then raise exception 'ORIGINAL_PAYMENT_NOT_FOUND'; end if;
    if v_original.reservation_id <> p_reservation_id then raise exception 'ORIGINAL_PAYMENT_NOT_IN_RESERVATION'; end if;
    if p_amount > v_original.amount then
      raise exception 'REFUND_EXCEEDS_ORIGINAL: pago original=% reembolso_intentado=%', v_original.amount, p_amount;
    end if;
  end if;

  select * into v_method from public.payment_methods
  where id = p_payment_method_id and hotel_id = p_hotel_id and is_active;
  if not found then raise exception 'PAYMENT_METHOD_NOT_FOUND_FOR_HOTEL'; end if;

  insert into public.payments (
    hotel_id, reservation_id, type, amount, currency, amount_local, method, status, payment_method_id, notes
  ) values (
    p_hotel_id, p_reservation_id, 'refund', -p_amount, coalesce(v_original.currency, 'MXN'), -p_amount,
    v_method.type, 'completed', p_payment_method_id,
    'Reembolso' || case when p_original_payment_id is not null then ' de pago ' || p_original_payment_id else '' end || ' -- ' || p_reason
  ) returning * into v_payment;

  insert into public.payment_movements (hotel_id, payment_id, payment_method_id, amount, created_by)
  values (p_hotel_id, v_payment.id, p_payment_method_id, -p_amount, auth.uid())
  returning id into v_movement_id;

  if v_method.type = 'cash' then
    select usa_turnos_caja into v_usa_turnos from public.cash_settings where hotel_id = p_hotel_id;
    select id into v_shift_id from public.cash_shifts where hotel_id = p_hotel_id and status = 'open';
    if coalesce(v_usa_turnos, true) and v_shift_id is null then
      raise exception 'NO_OPEN_CASH_SHIFT: abre un turno de caja antes de reembolsar en efectivo';
    end if;
    if v_shift_id is not null then
      insert into public.cash_movements (
        hotel_id, cash_shift_id, type, source, amount, concept, payment_movement_id, created_by
      ) values (
        p_hotel_id, v_shift_id, 'cash_out', 'payment', p_amount,
        'Reembolso -- ' || p_reason, v_movement_id, auth.uid()
      );
    end if;
  end if;

  return v_payment;
end;
$$;

revoke execute on function public.register_refund(uuid, uuid, uuid, numeric, uuid, text) from public;
grant execute on function public.register_refund(uuid, uuid, uuid, numeric, uuid, text) to authenticated;

-- ============================================================
-- 12) validate_payment(): marca aplicado un pago que quedo en
--     EN_VALIDACION (ej. transferencia ya confirmada por el banco).
-- ============================================================
create or replace function public.validate_payment(p_payment_id uuid)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;

  if not public.has_permission(v_payment.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;
  if v_payment.status <> 'pending_validation' then
    raise exception 'INVALID_TRANSITION: status actual es %', v_payment.status;
  end if;

  update public.payments set status = 'completed' where id = p_payment_id returning * into v_payment;
  return v_payment;
end;
$$;

revoke execute on function public.validate_payment(uuid) from public;
grant execute on function public.validate_payment(uuid) to authenticated;

-- ============================================================
-- 13) register_stay_adjustment(): unico camino para escribir una fila
--     'adjustment' en stay_transactions. El saldo de la CuentaEstancia
--     nunca se edita directo -- siempre es un movimiento con motivo.
-- ============================================================
create or replace function public.register_stay_adjustment(
  p_stay_id uuid,
  p_amount numeric,
  p_concept text
)
returns public.stay_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_account public.stay_accounts;
  v_transaction public.stay_transactions;
begin
  select * into v_stay from public.stays where id = p_stay_id;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;

  if not public.has_permission(v_stay.hotel_id, 'cash.adjust') then
    raise exception 'PERMISSION_DENIED: cash.adjust required' using errcode = '42501';
  end if;

  if p_amount = 0 then raise exception 'INVALID_AMOUNT: el ajuste no puede ser cero'; end if;
  if coalesce(p_concept, '') = '' then raise exception 'CONCEPT_REQUIRED'; end if;

  select * into v_account from public.stay_accounts where stay_id = p_stay_id for update;
  if v_account.status <> 'open' then
    raise exception 'ACCOUNT_CLOSED: la cuenta de esta estancia ya esta cerrada';
  end if;

  insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept)
  values (v_stay.hotel_id, v_account.id, 'adjustment', p_amount, p_concept)
  returning * into v_transaction;

  perform public.recompute_stay_next_action(p_stay_id);
  return v_transaction;
end;
$$;

revoke execute on function public.register_stay_adjustment(uuid, numeric, text) from public;
grant execute on function public.register_stay_adjustment(uuid, numeric, text) to authenticated;

-- ============================================================
-- 14) open_cash_shift() / close_cash_shift()
-- ============================================================
create or replace function public.open_cash_shift(
  p_hotel_id uuid,
  p_fondo_inicial numeric default 0,
  p_notes text default null
)
returns public.cash_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.cash_shifts;
begin
  if not public.has_permission(p_hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;

  if exists (select 1 from public.cash_shifts where hotel_id = p_hotel_id and status = 'open') then
    raise exception 'SHIFT_ALREADY_OPEN: ya hay un turno de caja abierto para este hotel';
  end if;

  insert into public.cash_shifts (hotel_id, fondo_inicial, opened_by, notes)
  values (p_hotel_id, coalesce(p_fondo_inicial, 0), auth.uid(), p_notes)
  returning * into v_shift;

  return v_shift;
end;
$$;

revoke execute on function public.open_cash_shift(uuid, numeric, text) from public;
grant execute on function public.open_cash_shift(uuid, numeric, text) to authenticated;

create or replace function public.close_cash_shift(
  p_shift_id uuid,
  p_efectivo_contado numeric,
  p_notes text default null
)
returns public.cash_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.cash_shifts;
  v_cash_in numeric;
  v_cash_out numeric;
  v_esperado numeric;
begin
  select * into v_shift from public.cash_shifts where id = p_shift_id for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;

  if not public.has_permission(v_shift.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;
  if v_shift.status <> 'open' then
    raise exception 'SHIFT_ALREADY_CLOSED';
  end if;

  select coalesce(sum(amount), 0) into v_cash_in
  from public.cash_movements where cash_shift_id = p_shift_id and type = 'cash_in';
  select coalesce(sum(amount), 0) into v_cash_out
  from public.cash_movements where cash_shift_id = p_shift_id and type = 'cash_out';

  v_esperado := v_shift.fondo_inicial + v_cash_in - v_cash_out;

  update public.cash_shifts
  set status = 'closed',
      efectivo_contado = p_efectivo_contado,
      efectivo_esperado = v_esperado,
      diferencia = p_efectivo_contado - v_esperado,
      closed_at = now(),
      closed_by = auth.uid(),
      notes = coalesce(p_notes, notes)
  where id = p_shift_id
  returning * into v_shift;

  return v_shift;
end;
$$;

revoke execute on function public.close_cash_shift(uuid, numeric, text) from public;
grant execute on function public.close_cash_shift(uuid, numeric, text) to authenticated;

-- ============================================================
-- 15) register_cash_expense(): egreso operativo menor (taxi, caja chica,
--     proveedor menor). Limite explicito de v1: nunca cuentas por pagar ni
--     gasto contable completo -- eso es el futuro modulo de Finanzas.
-- ============================================================
create or replace function public.register_cash_expense(
  p_shift_id uuid,
  p_amount numeric,
  p_concept text,
  p_category text default null,
  p_receipt_url text default null
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.cash_shifts;
  v_movement public.cash_movements;
begin
  select * into v_shift from public.cash_shifts where id = p_shift_id;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;

  if not public.has_permission(v_shift.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;
  if v_shift.status <> 'open' then
    raise exception 'SHIFT_CLOSED: no se pueden registrar egresos en un turno cerrado';
  end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if coalesce(p_concept, '') = '' then raise exception 'CONCEPT_REQUIRED'; end if;

  insert into public.cash_movements (
    hotel_id, cash_shift_id, type, source, amount, concept, category, receipt_url, authorized_by, created_by
  ) values (
    v_shift.hotel_id, p_shift_id, 'cash_out', 'operational_expense', p_amount, p_concept, p_category, p_receipt_url,
    auth.uid(), auth.uid()
  ) returning * into v_movement;

  return v_movement;
end;
$$;

revoke execute on function public.register_cash_expense(uuid, numeric, text, text, text) from public;
grant execute on function public.register_cash_expense(uuid, numeric, text, text, text) to authenticated;
