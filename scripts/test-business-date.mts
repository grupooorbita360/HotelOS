/**
 * Prueba standalone del cálculo puro de businessDate (src/lib/businessDate.ts).
 * No requiere Next.js/Supabase -- corre directo con `node scripts/test-business-date.mts`
 * (Node 22+ soporta TypeScript nativo). No se agregó un test runner nuevo
 * (jest/vitest) para esto: el proyecto no tenía ninguno configurado todavía
 * y este cambio debía ser pequeño y controlado.
 */
import { computeBusinessDate, isValidTimezone } from "../src/lib/businessDate.ts";

let failures = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL: ${label} -- esperado ${JSON.stringify(expected)}, obtuve ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK: ${label}`);
  }
}

// 1) Caso del enunciado: Cancún, UTC 2026-09-15 03:30 -> businessDate 2026-09-14.
const instant = new Date("2026-09-15T03:30:00Z");
assertEqual(computeBusinessDate("America/Cancun", instant), "2026-09-14", "Cancun @ 2026-09-15T03:30Z => 2026-09-14");

// 2) El mismo instante UTC en otro timezone debe poder dar una fecha distinta.
assertEqual(computeBusinessDate("Asia/Tokyo", instant), "2026-09-15", "Asia/Tokyo @ 2026-09-15T03:30Z => 2026-09-15");
assertEqual(computeBusinessDate("Pacific/Kiritimati", instant), "2026-09-15", "Pacific/Kiritimati @ mismo instante => 2026-09-15 (UTC+14)");

// 3) Un mismo hotel, dos instantes distintos que cruzan la medianoche local.
const beforeMidnightCancun = new Date("2026-09-15T04:59:00Z"); // 23:59 America/Cancun (UTC-5)
const afterMidnightCancun = new Date("2026-09-15T05:01:00Z"); // 00:01 America/Cancun
assertEqual(computeBusinessDate("America/Cancun", beforeMidnightCancun), "2026-09-14", "Cancun 23:59 local => 2026-09-14");
assertEqual(computeBusinessDate("America/Cancun", afterMidnightCancun), "2026-09-15", "Cancun 00:01 local => 2026-09-15");

// 4) America/Mexico_City (default de hoteles existentes) sigue funcionando igual.
assertEqual(computeBusinessDate("America/Mexico_City", instant), "2026-09-14", "America/Mexico_City @ 2026-09-15T03:30Z => 2026-09-14");

// 5) Timezone inválido: nunca debe fallar en silencio ni caer a UTC sin avisar.
assertEqual(isValidTimezone("America/Cancun"), true, "America/Cancun es válido");
assertEqual(isValidTimezone("America/Nowhere_Fake"), false, "America/Nowhere_Fake NO es válido");
assertEqual(isValidTimezone(""), false, "string vacío NO es válido");

let threw = false;
try {
  computeBusinessDate("America/Nowhere_Fake", instant);
} catch {
  threw = true;
}
assertEqual(threw, true, "computeBusinessDate lanza con un timezone inválido, no cae a UTC en silencio");

// 6) Timestamps técnicos (created_at/updated_at/etc.) siguen siendo UTC
// normal -- esta prueba documenta que NO deben pasar por businessDate.
const technicalTimestamp = new Date().toISOString();
assertEqual(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(technicalTimestamp), true, "timestamp técnico sigue siendo ISO UTC normal (no se toca)");

if (failures > 0) {
  console.error(`\n${failures} prueba(s) fallaron.`);
  process.exit(1);
}
console.log("\nTodas las pruebas de businessDate pasaron.");
