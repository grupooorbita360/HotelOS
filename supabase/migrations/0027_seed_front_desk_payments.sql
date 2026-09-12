-- Fix: el rol front_desk podia hacer checkin.perform/checkout.perform pero
-- no payments.register, y el modulo de Recepcion requiere que Recepcion
-- pueda cobrar/registrar transacciones de la CuentaEstancia directamente
-- (es su propia entidad contable, independiente de Caja -- ver
-- 0024_stay_accounts_transactions.sql). Esto ya coincidia con el rol de
-- Recepcion/Ventas descrito en la especificacion original de Reservaciones
-- ("Cotizar, crear reservas, registrar pagos"), pero el seed de 0009 no lo
-- incluyo.

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'payments.register'
where r.name = 'front_desk' and r.hotel_id is null
on conflict do nothing;
