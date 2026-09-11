-- HotelOS: funciones centrales de autorización. Se usan tanto dentro de las
-- políticas de RLS como desde el código de servidor (vía RPC) para validar
-- permisos antes de ejecutar una acción sensible (principio 2 de CLAUDE.md).
--
-- Son SECURITY DEFINER + STABLE: corren con privilegios del dueño (para poder
-- leer profiles/user_hotel_roles sin quedar atrapadas en su propia RLS) pero
-- sólo devuelven información derivada de auth.uid(), nunca datos crudos.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_platform_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

comment on function public.is_platform_admin() is
  'true si el usuario autenticado es staff de HotelOS (soporte/ops), con acceso a todos los hoteles.';

create or replace function public.user_hotel_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select hotel_id
  from public.user_hotel_roles
  where user_id = auth.uid() and is_active;
$$;

comment on function public.user_hotel_ids() is
  'Hoteles donde el usuario autenticado tiene al menos un rol activo. Base del aislamiento multi-tenant en RLS.';

create or replace function public.has_permission(p_hotel_id uuid, p_permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_platform_admin()
    or exists (
      select 1
      from public.user_hotel_roles uhr
      join public.role_permissions rp on rp.role_id = uhr.role_id
      join public.permissions p on p.id = rp.permission_id
      where uhr.user_id = auth.uid()
        and uhr.hotel_id = p_hotel_id
        and uhr.is_active
        and p.code = p_permission_code
    );
$$;

comment on function public.has_permission(uuid, text) is
  'Valida en servidor si el usuario autenticado puede ejecutar p_permission_code en p_hotel_id. Úsese en RLS y en cada server action antes de mutar datos.';

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.user_hotel_ids() to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;
