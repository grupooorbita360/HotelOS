-- HotelOS / Configuracion: para "invitar o dar de alta" un usuario en un
-- hotel, primero hay que saber si ese correo ya tiene cuenta en HotelOS
-- (se le asigna un rol nuevo) o no (hay que crear la cuenta). Un usuario
-- autenticado normal no puede consultar auth.users directamente -- no es
-- un esquema expuesto por PostgREST. Esta funcion SECURITY DEFINER expone
-- lo minimo indispensable: un id o null, nunca el resto de auth.users, y
-- solo a quien ya tiene permiso real de administrar staff en ESE hotel
-- (reusa has_permission(), igual que toda funcion SECURITY DEFINER del
-- proyecto que no pasa por RLS -- ver 0016/0026).

create or replace function public.find_user_id_by_email(p_hotel_id uuid, p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not public.has_permission(p_hotel_id, 'staff.manage') then
    raise exception 'PERMISSION_DENIED: staff.manage required' using errcode = '42501';
  end if;

  select id into v_user_id from auth.users where lower(email) = lower(p_email);
  return v_user_id;
end;
$$;

comment on function public.find_user_id_by_email(uuid, text) is
  'Devuelve el id de auth.users para un correo, o null si no existe cuenta todavia. Requiere staff.manage en p_hotel_id (validado adentro, no solo en el Server Action). Usado por el flujo de alta de usuarios de Configuracion para decidir entre invitar (cuenta nueva) o asignar rol (cuenta existente).';

grant execute on function public.find_user_id_by_email(uuid, text) to authenticated;
