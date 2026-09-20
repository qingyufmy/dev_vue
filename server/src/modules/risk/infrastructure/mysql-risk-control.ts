import { RiskError } from '../domain/risk.js'

/** Missing or malformed migration facts must never mean that trading is enabled. */
export function readRiskControl(row: { kill_switch: unknown; revision: unknown } | undefined) {
  if (!row || (row.kill_switch !== 0 && row.kill_switch !== 1)) throw new RiskError('risk_global_control_unavailable', 503)
  const raw = row.revision
  const revision = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(revision) || revision < 1) throw new RiskError('risk_global_control_unavailable', 503)
  return { globalKillSwitch: row.kill_switch === 1, revision }
}
