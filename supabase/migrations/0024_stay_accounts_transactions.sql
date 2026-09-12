-- HotelOS / Recepcion: CuentaEstancia y TransaccionCuenta.
--
-- Decision arquitectonica clave de este modulo: Recepcion tiene su propia
-- entidad contable, independiente de Caja. Recepcion lee/escribe esta
-- cuenta para decidir si puede entregar la habitacion o cerrar la cuenta.
-- Caja (modulo futuro) se encarga de instrumentos de pago (procesar
-- tarjetas, conciliacion, arqueo) y alimenta esta cuenta registrando pagos
-- como transacciones -- Recepcion NUNCA depende de Caja para saber si
-- puede operar.
--
-- Convencion de signo (saldo = "lo que el huesped debe"):
--   charge  (cargo)    -> amount > 0  (aumenta lo que debe)
--   payment (pago)     -> amount < 0  (el huesped pago, disminuye lo que debe)
--   refund  (reembolso)-> amount > 0  (se le devuelve un pago ya cobrado)

create table public.stay_accounts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  stay_id uuid not null unique references public.stays (id) on delete cascade,

  currency text not null default 'MXN',
  status text not null default 'open' check (status in ('open', 'closed')),

  -- Materializado por trigger desde stay_transactions (nunca se escribe a
  -- mano): balance = suma de amount de sus transacciones.
  balance numeric(12, 2) not null default 0,

  closed_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.stay_accounts is
  '1:1 con Estancia. balance es la suma de stay_transactions, mantenida por trigger -- nunca un campo editable a mano.';

create trigger trg_stay_accounts_audit
  before insert or update on public.stay_accounts
  for each row execute function public.set_audit_fields();

-- Alta automatica junto con la Estancia.
create or replace function public.handle_new_stay()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stay_accounts (hotel_id, stay_id) values (new.hotel_id, new.id);
  return new;
end;
$$;

create trigger trg_on_stay_created
  after insert on public.stays
  for each row execute function public.handle_new_stay();

create table public.stay_transactions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  stay_account_id uuid not null references public.stay_accounts (id) on delete cascade,

  type text not null check (type in ('charge', 'payment', 'refund')),
  amount numeric(12, 2) not null,
  concept text not null,
  method text check (method in ('cash', 'card', 'transfer', 'other')),

  -- Si esta fila anula una transaccion anterior (nunca se edita ni se
  -- borra una existente: anular = insertar una nueva referenciando la vieja).
  reversed_transaction_id uuid references public.stay_transactions (id),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  check (
    (type in ('charge', 'refund') and amount > 0)
    or (type = 'payment' and amount < 0)
  )
);

comment on table public.stay_transactions is
  'Movimiento individual de la CuentaEstancia. Inmutable: sin UPDATE ni DELETE. Anular un cargo/pago = insertar una transaccion nueva de signo contrario con reversed_transaction_id apuntando a la original.';

create index idx_stay_transactions_account on public.stay_transactions (stay_account_id);

-- Mantiene stay_accounts.balance = suma de sus transacciones. Es la unica
-- forma en que balance cambia; nunca se actualiza desde otro lugar.
create or replace function public.sync_stay_account_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.stay_accounts
  set balance = coalesce((
    select sum(amount) from public.stay_transactions
    where stay_account_id = new.stay_account_id
  ), 0)
  where id = new.stay_account_id;
  return new;
end;
$$;

create trigger trg_sync_stay_account_balance
  after insert on public.stay_transactions
  for each row execute function public.sync_stay_account_balance();

alter table public.stay_accounts enable row level security;
alter table public.stay_transactions enable row level security;

create policy "stay_accounts_select_member_or_platform_admin"
  on public.stay_accounts for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "stay_transactions_select_member_or_platform_admin"
  on public.stay_transactions for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Sin INSERT/UPDATE directos en ninguna de las dos: solo via
-- register_stay_transaction() / close_stay_account() en 0026.
