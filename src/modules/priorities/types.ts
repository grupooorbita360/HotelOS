import type { Json } from "@/types/database.types";

/**
 * Contrato de una ocurrencia detectada por un evaluador de regla. El motor
 * (engine.ts) toma esto y lo convierte en una fila de hotel_priorities vía
 * upsert_hotel_priority() -- el evaluador nunca escribe directo a la base
 * de datos, sólo lee y decide.
 */
export interface DetectedOccurrence {
  referenceType: string;
  referenceId: string;
  /** Formato "RULE_CODE:referencia", ej. "ARRIVAL_NOT_REGISTERED:<stayId>". */
  dedupeKey: string;
  title: string;
  message: string;
  actionLabel?: string;
  actionRoute?: string;
  actionContext?: Record<string, Json>;
  groupKey?: string;
  sourceEventId?: string;
  impactValue?: number;
  impactAmount?: number;
}

export interface EvaluatorContext {
  hotelId: string;
  /** Fecha operativa del hotel (getHotelBusinessDate), nunca UTC crudo. */
  businessDate: string;
}

/** Un evaluador = una función pura de lectura por rule.code. Nunca SQL dinámico ni código guardado en la base de datos. */
export type RuleEvaluator = (ctx: EvaluatorContext) => Promise<DetectedOccurrence[]>;

export const PRIORITY_STATUSES = ["OPEN", "ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "DISMISSED"] as const;
export type PriorityStatus = (typeof PRIORITY_STATUSES)[number];

export const ACTIVE_PRIORITY_STATUSES: PriorityStatus[] = ["OPEN", "ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS"];
