-- HotelOS: revoca el EXECUTE por defecto de PUBLIC en funciones internas.
--
-- Postgres otorga EXECUTE a PUBLIC automáticamente al crear una función,
-- salvo que se revoque explícitamente. Ninguna migración de este proyecto
-- lo había hecho nunca (confirmado por grep en las 44 migraciones
-- anteriores: el único "revoke" existente es el de 0038, y sólo contra
-- `authenticated`, no contra `public`). Eso significa que, salvo prueba en
-- contrario, TODAS las funciones -- incluyendo triggers y helpers
-- puramente internos -- eran ejecutables por `anon` de fábrica.
--
-- Confirmado contra Supabase real antes de escribir esta migración (no
-- asumido): una llamada anon a expire_stale_holds() devolvía 200 (la
-- ejecutaba de verdad, liberando Holds vencidos de CUALQUIER hotel); una
-- llamada anon a recompute_stay_next_action() con un stay_id real habría
-- sobreescrito stays.next_action de cualquier hotel sin sesión (probado
-- con un uuid inexistente, que devolvió 204 en vez de rechazar). Los
-- triggers (handle_*, set_audit_fields(), sync_stay_account_balance(),
-- set_updated_at_only()) no son alcanzables hoy vía PostgREST porque
-- `returns trigger` los excluye del cache de esquema de PostgREST
-- (confirmado: 404 "not found in schema cache" en los 9 casos) -- Postgres
-- además nunca permite invocar una función `returns trigger` fuera de un
-- disparo de trigger real, así que no son explotables ni siquiera a nivel
-- SQL directo. Aun así se revoca su EXECUTE de PUBLIC por higiene y para
-- que el catálogo de privilegios sea honesto con la intención (mismo
-- criterio que 0038 aplicó a upsert_hotel_priority()/
-- auto_resolve_stale_priorities()).
--
-- Ninguna de estas funciones se llama nunca directo desde una petición de
-- cliente en TypeScript (grep confirmado): todas se invocan sólo (a) como
-- trigger real disparado por Postgres, o (b) desde el CUERPO de otra
-- función SECURITY DEFINER/INVOKER de este mismo esquema. En ambos casos
-- Postgres resuelve el chequeo de EXECUTE contra el rol efectivo en ese
-- momento (el dueño de la función que las invoca, para las que corren
-- dentro de otro SECURITY DEFINER), nunca contra `anon`/`authenticated`
-- directo -- revocar PUBLIC no rompe ninguna de esas rutas internas.
--
-- assert_hotel_member() (0040, Fase 0) se incluye sólo por el mismo
-- patrón de higiene -- no se toca su lógica ni su archivo de origen. Ya
-- se auto-protege (rechaza a `anon` con PERMISSION_DENIED porque
-- user_hotel_ids() es vacío sin sesión), así que esto no corrige una
-- fuga real ahí, sólo cierra el mismo hueco de exposición innecesaria.
--
-- expire_stale_holds() conserva su grant explícito a `authenticated`
-- (0016, sin tocar): sigue siendo invocable por cualquier usuario con
-- sesión, tal como el diseño original preveía (limpieza perezosa de
-- Holds vencidos, sin datos sensibles en la respuesta). Sólo se cierra el
-- acceso sin sesión.

revoke execute on function public.set_audit_fields() from public;
revoke execute on function public.set_updated_at_only() from public;
revoke execute on function public.handle_new_auth_user() from public;
revoke execute on function public.handle_auth_user_email_change() from public;
revoke execute on function public.handle_new_hotel() from public;
revoke execute on function public.handle_new_hotel_reception_settings() from public;
revoke execute on function public.handle_new_reservation_stay() from public;
revoke execute on function public.handle_new_stay() from public;
revoke execute on function public.sync_stay_account_balance() from public;
revoke execute on function public.expire_stale_holds() from public;
revoke execute on function public.recompute_stay_next_action(uuid) from public;
revoke execute on function public.assert_hotel_member(uuid) from public;

-- Redundante con el revoke de PUBLIC de arriba (anon nunca tuvo un grant
-- propio, sólo heredaba vía PUBLIC), pero explícito para que quede claro
-- en el catálogo que `anon` nunca debe tener acceso a estas funciones,
-- incluso si en el futuro algo le otorgara un grant directo por error.
revoke execute on function public.set_audit_fields() from anon;
revoke execute on function public.set_updated_at_only() from anon;
revoke execute on function public.handle_new_auth_user() from anon;
revoke execute on function public.handle_auth_user_email_change() from anon;
revoke execute on function public.handle_new_hotel() from anon;
revoke execute on function public.handle_new_hotel_reception_settings() from anon;
revoke execute on function public.handle_new_reservation_stay() from anon;
revoke execute on function public.handle_new_stay() from anon;
revoke execute on function public.sync_stay_account_balance() from anon;
revoke execute on function public.expire_stale_holds() from anon;
revoke execute on function public.recompute_stay_next_action(uuid) from anon;
revoke execute on function public.assert_hotel_member(uuid) from anon;
