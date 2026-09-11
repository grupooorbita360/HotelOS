-- HotelOS / Reservaciones: Garantia vs Pago -- decision cerrada del spec
-- (S16, ADR-03 de la revision KIMI, coincide con la v1.2): nunca el mismo
-- registro. Garantia es una promesa retenida, no ingreso. Pago es ingreso
-- real con moneda y tasa de cambio congeladas para siempre.
--
-- "Sin garantia" NO es un tipo de Garantia (spec S16.1, decision cerrada):
-- que un hotel no requiera garantia es una configuracion
-- (hotel_policies.requires_guarantee = false), nunca una fila con
-- tipo='sin_garantia'. Por eso el catalogo de tipos aqui solo tiene los
-- valores que representan una garantia real.

create table public.guarantees (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  reservation_id uuid not null references public.reservations (id) on delete cascade,

  type text not null check (type in ('card_hold', 'cash_deposit')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'MXN',

  status text not null default 'active'
    check (status in ('active', 'released', 'charged', 'expired')),

  released_at timestamptz,
  charged_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.guarantees is
  'Promesa de pago retenida (tarjeta o efectivo en garantia). No es ingreso. Si el hotel recibe dinero fisico como garantia, ademas debe existir un Payment en paralelo (spec S16.2) -- esta tabla por si sola nunca representa dinero ya cobrado.';

create trigger trg_guarantees_audit
  before insert or update on public.guarantees
  for each row execute function public.set_audit_fields();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  reservation_id uuid not null references public.reservations (id) on delete cascade,

  type text not null check (type in ('deposit', 'installment', 'full_payment', 'refund')),
  amount numeric(12, 2) not null,
  currency text not null default 'MXN',

  -- Congelado al momento del cobro. Un pago historico nunca recalcula su
  -- tasa aunque la tasa vigente del hotel cambie despues (spec S18.1).
  exchange_rate_applied numeric(12, 6) not null default 1,
  amount_local numeric(12, 2) not null,

  method text not null check (method in ('card', 'transfer')),
  status text not null default 'completed'
    check (status in ('pending', 'completed', 'rejected', 'reversed')),

  receipt_url text,
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  check ((type = 'refund' and amount < 0) or (type <> 'refund' and amount > 0))
);

comment on table public.payments is
  'Ingreso real. Inmutable financieramente: un pago incorrecto no se edita ni se borra, se corrige con un Payment nuevo tipo refund (spec S18). exchange_rate_applied y amount_local quedan congelados para siempre en el momento del insert.';

create trigger trg_payments_audit
  before insert or update on public.payments
  for each row execute function public.set_audit_fields();

create index idx_guarantees_reservation on public.guarantees (reservation_id);
create index idx_payments_reservation on public.payments (reservation_id);

alter table public.guarantees enable row level security;
alter table public.payments enable row level security;

create policy "guarantees_select_member_or_platform_admin"
  on public.guarantees for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "guarantees_write_payments_register_or_platform_admin"
  on public.guarantees for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'payments.register'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'payments.register'));

create policy "payments_select_member_or_platform_admin"
  on public.payments for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Solo INSERT: un pago no se actualiza ni se borra desde la aplicacion
-- (inmutabilidad financiera). Reversar = insertar un Payment tipo refund.
create policy "payments_insert_payments_register_or_platform_admin"
  on public.payments for insert
  to authenticated
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'payments.register'));
