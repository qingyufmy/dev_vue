import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

export async function verifyRiskPriorHistory(connection, prior, history) {
  const entries = validateColumnHistory(history, prior.steps)
  if (prior.steps.length !== 166 || !prior.steps.every(step => entries.get(step.id)?.status === 'completed')) throw Error('risk_prior_history_incomplete')
  const [rows] = await connection.query('SELECT id,CAST(revision AS CHAR) revision FROM observer_management_registry WHERE id=1')
  if (rows.length !== 1 || Number(rows[0].id) !== 1 || !/^(0|[1-9][0-9]*)$/.test(rows[0].revision)
    || BigInt(rows[0].revision) >= BigInt(Number.MAX_SAFE_INTEGER)) throw Error('risk_prior_observer_registry_invalid')
  const contextIds = new Set(prior.context.steps.map(step => step.id))
  return { contextHistory: history.filter(row => contextIds.has(row.id)), observerRevision: rows[0].revision }
}
