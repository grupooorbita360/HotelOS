-- HotelOS / Recepcion: revertir "Walked" (P1-4, handoff de demo P1 Tanda 2).
--
-- mark_walked() (0026) ya funciona correctamente -- se probó en vivo contra
-- Supabase real antes de escribir esto (con y sin motivo, ambos casos
-- devuelven 200 y la estancia queda en status='walked') -- el reporte de
-- "Error desconocido" no se pudo reproducir contra el RPC ni contra el flujo
-- completo de la UI con datos limpios. Lo que sí se confirmó real, leyendo
-- src/lib/friendlyError.ts: INVALID_TRANSITION (y varios otros códigos que
-- las funciones de Recepción/Habitaciones ya lanzan) no estaban en el mapa
-- de mensajes conocidos -- cualquier error de negocio con ese código caía al
-- mensaje genérico, exactamente el tipo de experiencia "no me dice qué pasó"
-- que el reporte describe. Se corrige aparte en el mismo commit de TypeScript
-- (friendlyError.ts), no aquí.
--
-- Lo que sí faltaba de verdad, y es el propósito real de esta migración:
-- "Marcar Walked" no era reversible -- un walked por error (el caso más
-- probable en la operación real: alguien marca Walked al huésped
-- equivocado) no tenía forma de deshacerse. undo_walked() cierra ese hueco,
-- mismo patrón que reactivate_room() (0041): limpia walked_at/walked_reason
-- y regresa el status a 'arrived' (el estado inmediatamente anterior a
-- mark_walked() en la máquina de estados de Estancia, 0022) -- nunca a
-- 'expected', que perdería el hecho real de que el huésped sí llegó.

create or replace function public.undo_walked(p_stay_id uuid, p_reason text default null)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;
  if v_stay.status <> 'walked' then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "walked"', v_stay.status;
  end if;

  update public.stays
  set status = 'arrived', walked_at = null, walked_reason = null
  where id = p_stay_id;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

comment on function public.undo_walked(uuid, text) is
  'Deshace mark_walked() (P1-4, handoff de demo P1 Tanda 2): regresa la estancia a "arrived" (nunca "expected" -- el huésped sí llegó) y limpia walked_at/walked_reason. El evento original (stay.walked) y el de deshacer (stay.walked_undone) quedan ambos en timeline_events -- el historial de que ocurrió y se corrigió no se borra, sólo el estado operativo actual.';

revoke execute on function public.undo_walked(uuid, text) from public;
revoke execute on function public.undo_walked(uuid, text) from anon;
grant execute on function public.undo_walked(uuid, text) to authenticated;
