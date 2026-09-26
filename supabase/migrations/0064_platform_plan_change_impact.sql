-- HotelOS — Plataforma: impact analysis ANTES de cambiar de plan (auditoría
-- externa §16). Se aplica junto a 0063_platform_limit_enforcement.sql.
-- Nunca cambiar de plan "a ciegas": un downgrade puede dejar features
-- fuera y uso por encima de los límites nuevos.
--
-- plan_change_impact() recibe el plan nuevo Y los límites de licencia
-- propuestos, porque los límites viven en hotel_licenses (0039), no en el
-- plan: el admin evalúa "Pro → Básico con rooms_max=16" antes de guardar.
-- La función no muta nada: solo reporta. El cambio real sigue siendo
-- UPDATE a hotels/hotel_licencias.
--
-- Seguridad: SECURITY DEFINER con guard explícito de platform_admin.

create or replace function public.plan_change_impact(
  p_hotel_id uuid,
  p_new_plan text,
  p_new_rooms_max integer default null,
  p_new_users_max integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_current_plan text;
  v_current_features text[];
  v_new_features text[];
  v_rooms_active integer;
  v_users_active integer;
begin
  if not public.is_platform_admin() then
    raise exception 'PERMISSION_DENIED: platform admin only' using errcode = '42501';
  end if;

  if p_new_plan not in ('basico', 'plus', 'pro') then
    raise exception 'INVALID_PLAN: %', p_new_plan using errcode = '22023';
  end if;

  select plan into v_current_plan from public.hotels where id = p_hotel_id;
  if not found then
    raise exception 'HOTEL_NOT_FOUND: %', p_hotel_id using errcode = 'P0002';
  end if;

  -- Features actuales efectivas (plan + overrides, igual que el menú del hotel).
  select coalesce(array_agg(f), '{}') into v_current_features
    from public.hotel_enabled_features(p_hotel_id) f;

  -- Features efectivas bajo el plan nuevo, conservando los overrides
  -- existentes del hotel (un override gana sobre cualquier plan).
  select coalesce(array_agg(feature_key), '{}') into v_new_features
  from (
    select pf.feature_key from public.plan_features pf where pf.plan = p_new_plan and pf.enabled
    union
    select o.feature_key from public.hotel_feature_overrides o where o.hotel_id = p_hotel_id and o.enabled
    except
    select o.feature_key from public.hotel_feature_overrides o where o.hotel_id = p_hotel_id and not o.enabled
  ) eff;

  select count(*) into v_rooms_active from public.rooms
   where hotel_id = p_hotel_id and is_active;
  select count(distinct user_id) into v_users_active from public.user_hotel_roles
   where hotel_id = p_hotel_id and is_active;

  return jsonb_build_object(
    'hotel_id', p_hotel_id,
    'current_plan', v_current_plan,
    'new_plan', p_new_plan,
    'features_gained', coalesce((
      select jsonb_agg(x order by x) from (
        select unnest(v_new_features) as x
        except select unnest(v_current_features)
      ) d), '[]'::jsonb),
    'features_lost', coalesce((
      select jsonb_agg(x order by x) from (
        select unnest(v_current_features) as x
        except select unnest(v_new_features)
      ) d), '[]'::jsonb),
    'rooms', jsonb_build_object(
      'active', v_rooms_active,
      'current_max', (select rooms_max from public.hotel_licenses where hotel_id = p_hotel_id),
      'proposed_max', p_new_rooms_max,
      'would_exceed', (p_new_rooms_max is not null and v_rooms_active > p_new_rooms_max)
    ),
    'users', jsonb_build_object(
      'active', v_users_active,
      'current_max', (select users_max from public.hotel_licenses where hotel_id = p_hotel_id),
      'proposed_max', p_new_users_max,
      'would_exceed', (p_new_users_max is not null and v_users_active > p_new_users_max)
    ),
    'blocking', (p_new_rooms_max is not null and v_rooms_active > p_new_rooms_max)
             or (p_new_users_max is not null and v_users_active > p_new_users_max),
    'generated_at', now()
  );
end;
$$;

comment on function public.plan_change_impact(uuid, text, integer, integer) is
  'Impact analysis ANTES de cambiar plan: features ganadas/perdidas y exceso de límites con los valores propuestos. Solo platform_admin. No muta nada.';

grant execute on function public.plan_change_impact(uuid, text, integer, integer) to authenticated;
