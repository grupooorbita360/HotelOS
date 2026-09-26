import "server-only";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getHotelBusinessDate } from "@/lib/getHotelBusinessDate";
import { logTimelineEvent } from "@/lib/events/timeline";
import { arrivalNotRegisteredEvaluator } from "./evaluators/arrivalNotRegistered";
import { holdExpiringSoonEvaluator } from "./evaluators/holdExpiringSoon";
import type { RuleEvaluator } from "./types";

/**
 * Registro explícito rule.code -> evaluador. A propósito NO es dinámico:
 * agregar una regla nueva significa escribir un evaluador de TypeScript y
 * añadirlo aquí, nunca guardar código o SQL en hotel_rules (ver CLAUDE.md,
 * "Motor de reglas y Prioridades").
 */
const EVALUATORS: Record<string, RuleEvaluator> = {
  ARRIVAL_NOT_REGISTERED: arrivalNotRegisteredEvaluator,
  HOLD_EXPIRING_SOON: holdExpiringSoonEvaluator,
};

export interface RuleEvaluationSummary {
  ruleCode: string;
  detectedCount: number;
  newCount: number;
  autoResolvedCount: number;
}

/**
 * Evalúa todas las reglas globales activas contra el estado actual del
 * hotel: por cada regla con evaluador registrado, detecta ocurrencias,
 * las sube vía upsert_hotel_priority() (dedupe atómico -- nunca duplica
 * una prioridad activa), y auto-resuelve las que ya no aplican. Sólo
 * registra timeline_events para detecciones/resoluciones genuinamente
 * nuevas, nunca por cada evaluación (principio 12 de la tarea).
 */
export async function evaluateHotelRules(
  hotelId: string,
  supabaseClient?: Awaited<ReturnType<typeof createClient>>,
): Promise<RuleEvaluationSummary[]> {
  // supabaseClient opcional (P2-2): scheduleHotelRuleEvaluation() lo
  // construye ANTES de entrar a after() (next/server) y lo inyecta aquí --
  // cookies() no se puede leer dentro de ese callback, así que createClient()
  // fallaría si se llamara aquí adentro cuando el caller es after(). Un
  // caller directo (fuera de after()) sigue sin pasar nada.
  const supabase = supabaseClient ?? (await createClient());
  // upsert_hotel_priority()/auto_resolve_stale_priorities() (0038) sólo
  // aceptan llamadas de service_role -- son las dos primitivas internas
  // del motor, nunca una API pública de mutación. El resto de esta
  // función (catálogo de reglas, evaluadores) sigue con `supabase`
  // (cliente de sesión), respetando RLS igual que siempre: esto no
  // cambia quién puede disparar la evaluación, sólo con qué credencial
  // sale la escritura final.
  const adminClient = createAdminClient();
  const businessDate = await getHotelBusinessDate(hotelId, supabase);

  const { data: rules, error: rulesError } = await supabase
    .from("hotel_rules")
    .select("id, code")
    .is("hotel_id", null)
    .eq("is_active", true);
  if (rulesError) throw rulesError;

  const summaries: RuleEvaluationSummary[] = [];

  for (const rule of rules ?? []) {
    const evaluator = EVALUATORS[rule.code];
    if (!evaluator) continue; // regla en catálogo sin evaluador implementado todavía

    const occurrences = await evaluator({ hotelId, businessDate, supabaseClient: supabase });
    const activeDedupeKeys: string[] = [];
    let newCount = 0;

    for (const occ of occurrences) {
      activeDedupeKeys.push(occ.dedupeKey);

      const { data: result, error } = await adminClient.rpc("upsert_hotel_priority", {
        p_hotel_id: hotelId,
        p_rule_id: rule.id,
        p_reference_type: occ.referenceType,
        p_reference_id: occ.referenceId,
        p_title: occ.title,
        p_message: occ.message,
        p_action_label: occ.actionLabel ?? null,
        p_action_route: occ.actionRoute ?? null,
        p_action_context: occ.actionContext ?? {},
        p_dedupe_key: occ.dedupeKey,
        p_group_key: occ.groupKey ?? null,
        p_source_event_id: occ.sourceEventId ?? null,
        p_impact_value: occ.impactValue ?? null,
        p_impact_amount: occ.impactAmount ?? null,
      });
      if (error) throw error;

      const row = result?.[0];
      if (row?.out_is_new) {
        newCount += 1;
        await logTimelineEvent({
          hotelId,
          module: "priorities",
          eventType: "priority.detected",
          entityType: "hotel_priority",
          entityId: row.out_priority_id,
          payload: {
            rule_code: rule.code,
            reference_type: occ.referenceType,
            reference_id: occ.referenceId,
            dedupe_key: occ.dedupeKey,
          },
          supabaseClient: supabase,
        });
      }
    }

    const { data: resolvedRows, error: resolveError } = await adminClient.rpc("auto_resolve_stale_priorities", {
      p_hotel_id: hotelId,
      p_rule_id: rule.id,
      p_active_dedupe_keys: activeDedupeKeys,
    });
    if (resolveError) throw resolveError;

    for (const resolved of resolvedRows ?? []) {
      await logTimelineEvent({
        hotelId,
        module: "priorities",
        eventType: "priority.resolved",
        entityType: "hotel_priority",
        entityId: resolved.out_priority_id,
        payload: { rule_code: rule.code, auto_resolved: true },
        supabaseClient: supabase,
      });
    }

    summaries.push({
      ruleCode: rule.code,
      detectedCount: occurrences.length,
      newCount,
      autoResolvedCount: resolvedRows?.length ?? 0,
    });
  }

  return summaries;
}

/**
 * Punto único de invocación real del motor (antes no existía ninguno --
 * ver CLAUDE.md, sección P2-2). AppShell (compartido por las 5 páginas de
 * módulo) llama a esto en cada request; se decidió evaluar aquí y no por
 * página para que reglas como HOLD_EXPIRING_SOON se disparen sin importar
 * en qué pantalla esté el usuario.
 *
 * Cooldown en memoria (mismo patrón que el cache de 45s de getRackGrid(),
 * ver sección Rack de CLAUDE.md): sin esto, cada navegación repetiría la
 * misma evaluación completa -- desperdicio real de trabajo, no solo de
 * latencia. Igual que ese cache, esto es un Map por proceso, no
 * distribuido -- en un despliegue multi-instancia cada instancia evalúa
 * por su cuenta, lo cual está bien: el peor caso es evaluar de más, nunca
 * de menos (a diferencia del cache de lectura del Rack, donde servir una
 * copia vieja sí sería un problema).
 *
 * after() (next/server, estable desde Next 15) corre el trabajo real
 * DESPUÉS de que la respuesta ya se mandó al navegador -- ninguna página
 * paga la latencia de evaluar todas las reglas del hotel sólo por
 * cargar. Un error de evaluación nunca debe tumbar el render de la página
 * que lo disparó (por eso el .catch() en vez de dejar que after() lo
 * propague sin control).
 *
 * Bug real encontrado probando esto contra Supabase real: createClient()
 * (y por lo tanto getHotelBusinessDate()/cada evaluador, que lo llaman por
 * su cuenta) lee cookies() -- y Next.js rechaza explícitamente leer
 * cookies() DENTRO del callback de after() ("used cookies() inside after()
 * while rendering. This is not supported"), aunque ya se haya leído antes
 * en el mismo request (AppShell ya llama getLocale()/getCurrentUserHotel()
 * antes de esto). Por eso el cliente se construye AQUÍ, antes de llamar
 * after(), y se inyecta en evaluateHotelRules() (que a su vez lo pasa a
 * getHotelBusinessDate() y a cada evaluador vía EvaluatorContext.
 * supabaseClient) -- el callback de after() nunca vuelve a tocar cookies().
 */
const EVALUATION_COOLDOWN_MS = 3 * 60 * 1000;
const lastEvaluatedAt = new Map<string, number>();

export async function scheduleHotelRuleEvaluation(hotelId: string): Promise<void> {
  const now = Date.now();
  const last = lastEvaluatedAt.get(hotelId) ?? 0;
  if (now - last < EVALUATION_COOLDOWN_MS) return;
  lastEvaluatedAt.set(hotelId, now);

  const supabase = await createClient();
  after(() => {
    evaluateHotelRules(hotelId, supabase).catch((error) => {
      console.error(`evaluateHotelRules(${hotelId}) failed`, error);
    });
  });
}
