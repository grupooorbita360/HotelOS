-- Fix: register_stay_transaction() y void_stay_transaction() insertaban en
-- stay_transactions sin fijar created_by, quedando NULL siempre -- se
-- detecto al probar el flujo completo contra Supabase real (auditoria
-- rota, viola principio 3 de CLAUDE.md). stay_transactions es append-only
-- y no tiene updated_at/updated_by, asi que no puede usar el trigger
-- generico set_audit_fields() (fallaria al no existir esas columnas); la
-- correccion es que la propia funcion fije created_by = auth.uid() en el
-- INSERT, igual que timeline_events lo hace via RLS pero aqui via la
-- funcion SECURITY DEFINER ya que esta tabla no acepta INSERT directo del
-- cliente.
--
-- No se edita 0026 (ya aplicada); se reemplazan las funciones aqui.

create or replace function public.register_stay_transaction(
  p_stay_id uuid,
  p_type text,
  p_amount numeric,
  p_concept text,
  p_method text default null
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
  if not public.has_permission(v_stay.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;

  select * into v_account from public.stay_accounts where stay_id = p_stay_id for update;
  if v_account.status <> 'open' then
    raise exception 'ACCOUNT_CLOSED: la cuenta de esta estancia ya esta cerrada';
  end if;

  if p_type in ('charge', 'refund') and p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: % debe ser positivo', p_type;
  end if;
  if p_type = 'payment' and p_amount >= 0 then
    raise exception 'INVALID_AMOUNT: payment debe ser negativo';
  end if;

  insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method, created_by)
  values (v_stay.hotel_id, v_account.id, p_type, p_amount, p_concept, p_method, auth.uid())
  returning * into v_transaction;

  perform public.recompute_stay_next_action(p_stay_id);
  return v_transaction;
end;
$$;

create or replace function public.void_stay_transaction(p_transaction_id uuid, p_reason text default null)
returns public.stay_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.stay_transactions;
  v_account public.stay_accounts;
  v_stay_id uuid;
  v_new_type text;
  v_new public.stay_transactions;
begin
  select * into v_original from public.stay_transactions where id = p_transaction_id;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;

  select * into v_account from public.stay_accounts where id = v_original.stay_account_id;
  if not public.has_permission(v_account.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;
  if v_account.status <> 'open' then
    raise exception 'ACCOUNT_CLOSED: la cuenta de esta estancia ya esta cerrada';
  end if;

  v_new_type := case when v_original.type = 'payment' then 'refund' else 'payment' end;
  v_stay_id := v_account.stay_id;

  insert into public.stay_transactions (
    hotel_id, stay_account_id, type, amount, concept, method, reversed_transaction_id, created_by
  ) values (
    v_account.hotel_id, v_account.id, v_new_type, -v_original.amount,
    'Anulacion: ' || v_original.concept || coalesce(' -- ' || p_reason, ''),
    v_original.method, v_original.id, auth.uid()
  ) returning * into v_new;

  perform public.recompute_stay_next_action(v_stay_id);
  return v_new;
end;
$$;
