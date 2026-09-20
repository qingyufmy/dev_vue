export interface ChanEvidencePlan { version: 1; enabled: boolean }
export function parseChanEvidencePlan(value: unknown): ChanEvidencePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('chan_plan_invalid')
  const plan = value as Record<string, unknown>
  if (Object.keys(plan).length !== 2 || plan.version !== 1 || typeof plan.enabled !== 'boolean') throw Error('chan_plan_invalid')
  return { version: 1, enabled: plan.enabled }
}
