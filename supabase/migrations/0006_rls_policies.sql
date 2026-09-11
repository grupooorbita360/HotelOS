-- HotelOS: políticas RLS para hotels, profiles, roles, permissions,
-- role_permissions y user_hotel_roles. Se definen aquí porque dependen de
-- public.is_platform_admin() / public.has_permission() (creadas en 0005).

-- ── hotels ──────────────────────────────────────────────────────────────
create policy "hotels_select_member_or_platform_admin"
  on public.hotels for select
  to authenticated
  using (id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "hotels_insert_platform_admin_only"
  on public.hotels for insert
  to authenticated
  with check (public.is_platform_admin());

create policy "hotels_update_settings_manager_or_platform_admin"
  on public.hotels for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(id, 'hotel.settings.manage'));

-- Sin política de DELETE: baja de hotel = status = 'canceled', nunca DELETE.

-- ── profiles ────────────────────────────────────────────────────────────
create policy "profiles_select_self_or_hotelmate_or_platform_admin"
  on public.profiles for select
  to authenticated
  using (
    id = auth.uid()
    or public.is_platform_admin()
    or exists (
      select 1 from public.user_hotel_roles mine
      join public.user_hotel_roles theirs on theirs.hotel_id = mine.hotel_id
      where mine.user_id = auth.uid() and mine.is_active
        and theirs.user_id = public.profiles.id and theirs.is_active
    )
  );

create policy "profiles_update_self_or_platform_admin"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_platform_admin())
  with check (
    id = auth.uid() and (
      -- un usuario normal no puede auto-otorgarse is_platform_admin
      is_platform_admin = false or public.is_platform_admin()
    )
    or public.is_platform_admin()
  );

-- Sin INSERT/DELETE: el alta ocurre por trigger (handle_new_auth_user) y no
-- se permite borrar perfiles desde la aplicación (is_active = false en su lugar).

-- ── roles / permissions / role_permissions (catálogos) ─────────────────
-- v1: sólo plataforma administra los catálogos. Los hoteles seleccionan
-- entre los roles existentes para asignar a su personal (user_hotel_roles).
create policy "roles_select_global_or_own_hotel_or_platform_admin"
  on public.roles for select
  to authenticated
  using (
    hotel_id is null
    or hotel_id in (select public.user_hotel_ids())
    or public.is_platform_admin()
  );

create policy "roles_write_platform_admin_only"
  on public.roles for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy "permissions_select_authenticated"
  on public.permissions for select
  to authenticated
  using (true);

create policy "permissions_write_platform_admin_only"
  on public.permissions for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy "role_permissions_select_authenticated"
  on public.role_permissions for select
  to authenticated
  using (true);

create policy "role_permissions_write_platform_admin_only"
  on public.role_permissions for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ── user_hotel_roles ─────────────────────────────────────────────────────
create policy "user_hotel_roles_select_own_or_staff_manager_or_platform_admin"
  on public.user_hotel_roles for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_platform_admin()
    or public.has_permission(hotel_id, 'staff.manage')
  );

create policy "user_hotel_roles_write_staff_manager_or_platform_admin"
  on public.user_hotel_roles for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'staff.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'staff.manage'));
