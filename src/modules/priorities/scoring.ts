/**
 * Scoring simple y determinista (principio 9 de la tarea: nada de ML).
 * priority_score = peso de la severidad + priority_weight de la regla.
 * Deliberadamente NO incluye dinero (impact_amount): una oportunidad
 * comercial de alto valor no debe desplazar una situación operativa
 * crítica sólo por tener más impacto económico. Aging/escalation queda
 * para una evolución futura -- por ahora el score es estático por
 * detección.
 */
const SEVERITY_WEIGHTS: Record<string, number> = {
  low: 10,
  medium: 20,
  high: 30,
  critical: 40,
};

export function computePriorityScore(severity: string, ruleWeight: number): number {
  return (SEVERITY_WEIGHTS[severity] ?? 0) + ruleWeight;
}
