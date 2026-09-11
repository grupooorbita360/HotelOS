# HotelOS

Sistema operativo para hoteles independientes y pequeños. Multi-tenant desde
el diseño, con permisos y auditoría reales en el servidor (Postgres/Supabase),
no sólo en la interfaz.

**Antes de tocar código, lee [`CLAUDE.md`](./CLAUDE.md).** Ahí están los
principios de arquitectura no negociables del proyecto, el esquema de base
de datos, la estructura de carpetas y las convenciones.

## Stack

- Next.js (App Router, TypeScript)
- Supabase (Postgres, Auth, Storage)
- Tailwind CSS

## Empezar

1. Instalar dependencias: `npm install`
2. Copiar `.env.example` a `.env.local` y llenar las credenciales de tu
   proyecto de Supabase (ver instrucciones en el propio archivo).
3. Aplicar el esquema de base de datos: `npx supabase link --project-ref <ref>`
   y luego `npx supabase db push` (corre todo lo de `supabase/migrations/`).
4. Levantar el proyecto: `npm run dev` y abrir [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` — servidor de desarrollo
- `npm run build` — build de producción
- `npm run lint` — ESLint
