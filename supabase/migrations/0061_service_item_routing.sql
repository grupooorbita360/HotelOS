-- HotelOS / Recepcion: enrutamiento minimo de solicitudes/incidencias a
-- Housekeeping/Mantenimiento (P2-3, propuesta aprobada por el dueño del
-- producto).
--
-- guest_requests y stay_incidents (0025) ya existen, separadas a proposito
-- (servicio al cliente vs. operacion/mantenimiento) -- no se fusionan aqui.
-- Housekeeping/Mantenimiento como MODULOS completos (con sus propios
-- roles/cuentas) siguen sin construirse, pedido explicito -- por eso
-- assigned_area es una etiqueta de triage (a que equipo se enruta), no una
-- asignacion a un rol real del sistema, y assigned_to es opcional (para el
-- hotel que si tenga a alguien real que asignar). Aditivo sobre dos tablas
-- en produccion con datos reales: columnas nullable, catalogos de status
-- ampliados en superset, ninguna fila existente cambia.
--
-- Sin funcion SECURITY DEFINER nueva: a diferencia de dinero/inventario,
-- aqui no hay un invariante multi-tenant que proteger mas alla de
-- "pertenece a tu hotel", que RLS ya garantiza (mismo patron que
-- createGuestRequest()/resolveGuestRequest() ya usan -- 0025, sin cambios
-- de politica necesarios: sus "for all"/"for update" ya cubren cualquier
-- columna de la fila, incluidas las nuevas).

alter table public.guest_requests
  add column assigned_area text check (assigned_area in ('housekeeping', 'maintenance')),
  add column assigned_to uuid references auth.users (id);

alter table public.stay_incidents
  add column assigned_area text check (assigned_area in ('housekeeping', 'maintenance')),
  add column assigned_to uuid references auth.users (id);

comment on column public.guest_requests.assigned_area is
  'A que equipo se enruta (housekeeping|maintenance), nullable. Housekeeping/Mantenimiento no existen como modulos/roles reales todavia (P2-3) -- esto es solo una etiqueta de triage visible para Recepcion/Gerencia, no control de acceso.';
comment on column public.guest_requests.assigned_to is
  'Usuario especifico asignado, opcional -- para el hotel que si tenga a alguien real que asignar. No se valida pertenencia a un area (no existen); solo lo exige la FK a auth.users.';
comment on column public.stay_incidents.assigned_area is
  'Mismo criterio que guest_requests.assigned_area.';
comment on column public.stay_incidents.assigned_to is
  'Mismo criterio que guest_requests.assigned_to.';

-- Catalogos de status ampliados: ganan 'assigned' (y stay_incidents tambien
-- 'in_progress', que guest_requests ya tenia desde 0025) para reflejar la
-- progresion pedida nueva->asignada->en curso->resuelta. Los checks
-- originales eran anonimos (declarados inline en 0025) -- se localizan por
-- catalogo (pg_constraint), nunca se asume un nombre autogenerado que
-- pudiera no coincidir entre entornos (mismo patron cauteloso que 0033/0046).
do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.guest_requests'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%completed%cancelled%';

  if v_conname is not null then
    execute format('alter table public.guest_requests drop constraint %I', v_conname);
  end if;

  alter table public.guest_requests
    add constraint guest_requests_status_check
    check (status in ('open', 'assigned', 'in_progress', 'completed', 'cancelled'));
end $$;

do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.stay_incidents'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%open%resolved%';

  if v_conname is not null then
    execute format('alter table public.stay_incidents drop constraint %I', v_conname);
  end if;

  alter table public.stay_incidents
    add constraint stay_incidents_status_check
    check (status in ('open', 'assigned', 'in_progress', 'resolved'));
end $$;
