import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getHotelBusinessDate } from "@/lib/getHotelBusinessDate";
import { logTimelineEvent } from "@/lib/events/timeline";
import { computePriorityScore } from "./scoring";
import { arrivalNotRegisteredEvaluator } from "./evaluators/arrivalNotRegistered";
import type { RuleEvaluator } from "./types";

/**
 * Registro explícito rule.code -> evaluador. A propósito NO es dinámico:
 * agregar una regla nueva significa escribir un evaluador de TypeScript y
 * añadirlo aquí, nunca guardar código o SQL en hotel_rules (ver CLAUDE.md,
 * "Motor de reglas y Prioridades").
 */
const EVALUATORS: Record<string, RuleEvaluator> = {
  ARRIVAL_NOT_REGISTERED: arrivalNotRegisteredEvaluator,
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
export async function evaluateHotelRules(hotelId: string): Promise<RuleEvaluationSummary[]> {
  const supabase = await createClient();
  const businessDate = await getHotelBusinessDate(hotelId);

  const { data: rules, error: rulesError } = await supabase
    .from("hotel_rules")
    .select("id, code, module, category, severity, priority_weight")
    .is("hotel_id", null)
    .eq("is_active", true);
  if (rulesError) throw rulesError;

  const summaries: RuleEvaluationSummary[] = [];

  for (const rule of rules ?? []) {
    const evaluator = EVALUATORS[rule.code];
    if (!evaluator) continue; // regla en catálogo sin evaluador implementado todavía

    const occurrences = await evaluator({ hotelId, businessDate });
    const activeDedupeKeys: string[] = [];
    let newCount = 0;

    for (const occ of occurrences) {
      activeDedupeKeys.push(occ.dedupeKey);

      const { data: result, error } = await supabase.rpc("upsert_hotel_priority", {
        p_hotel_id: hotelId,
        p_rule_id: rule.id,
        p_source_module: rule.module,
        p_reference_type: occ.referenceType,
        p_reference_id: occ.referenceId,
        p_category: rule.category,
        p_severity: rule.severity,
        p_priority_score: computePriorityScore(rule.severity, rule.priority_weight),
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
        });
      }
    }

    const { data: resolvedRows, error: resolveError } = await supabase.rpc("auto_resolve_stale_priorities", {
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
