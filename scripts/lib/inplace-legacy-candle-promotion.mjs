import { readFile } from 'node:fs/promises'
import { loadLegacyCandleBuildMigration } from './inplace-legacy-candle-build-migration.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'
import { legacyCandleRenameSql, legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

const check = (value, code) => { if (!value) throw Error('legacy_candle_promotion_' + code) }
const immutable = ['market_candles_legacy_v3', 'market_data_sources', 'legacy_candle_mappings_v4', 'legacy_candle_backfill_v4']
export async function loadLegacyCandlePromotion(root) {
  const prior = await loadLegacyCandleBuildMigration(root)
  check(prior.steps.length === 163, 'prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/040_legacy_candle_promotion.sql', root), 'utf8'))
  check(statements.length === 1 && statements[0] === legacyCandleRenameSql(), 'sql_drift')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const body = { id: 'inplace_040_01_legacy_candle_promotion', sql: statements[0], protocol: 'legacy-candle-promotion/v1', priorRegistryHash }
  const step = { ...body, checksum: hash(body) }
  return { prior, priorRegistryHash, step, steps: [...prior.steps, step] }
}
export function prepareLegacyCandlePromotionProof(plan, identity, tables, backfillProofHash, tools) {
  const body = { kind: 'legacy-candle-promotion-proof/v1', identity, stepChecksum: plan.step.checksum,
    priorRegistryHash: plan.priorRegistryHash, backfillProofHash, tools,
    before: legacyCandlePromotionSnapshot(tables), after: legacyCandlePromotionSnapshot(tables, { promote: true }) }
  return { ...body, proofHash: hash(body) }
}

function validateProof(proof, plan, identity) {
  const { proofHash, ...body } = proof ?? {}
  check(body.kind === 'legacy-candle-promotion-proof/v1' && hash(body) === proofHash, 'proof_hash')
  check(hash(body.identity) === hash(identity) && body.stepChecksum === plan.step.checksum && body.priorRegistryHash === plan.priorRegistryHash, 'proof_binding')
  check(/^[a-f0-9]{64}$/.test(body.backfillProofHash), 'backfill_proof')
  for (const rows of [body.before, body.after]) {
    check(Array.isArray(rows) && rows.length > 0 && new Set(rows.map(row => row.name)).size === rows.length
      && rows.some(row => row.name === 'database_upgrade_steps_v4'), 'proof_snapshot')
    for (const row of rows) check(/^[a-z][a-z0-9_]*$/.test(row.name) && /^[a-f0-9]{64}$/.test(row.ddlSha256) && /^[a-f0-9]{64}$/.test(row.schemaSha256)
      && (row.name === 'database_upgrade_steps_v4' ? row.rows === undefined && row.rowsSha256 === undefined
        : Number.isSafeInteger(row.rows) && row.rows >= 0 && /^[a-f0-9]{64}$/.test(row.rowsSha256)), 'proof_row')
  }
  check(immutable.every(name => body.after.some(row => row.name === name)) && body.after.some(row => row.name === 'market_candles')
    && !body.after.some(row => row.name === 'market_candles_build_v4') && !body.before.some(row => row.name === 'market_candles_legacy_v3'), 'proof_layout')
  const renamed = body.before.map(row => ({ ...row, name: row.name === 'market_candles' ? 'market_candles_legacy_v3' : row.name === 'market_candles_build_v4' ? 'market_candles' : row.name })).sort((a, b) => a.name.localeCompare(b.name))
  check(renamed.length === body.after.length && renamed.every((row, i) => row.name === body.after[i].name && row.rows === body.after[i].rows && row.rowsSha256 === body.after[i].rowsSha256), 'proof_row_mapping')
  check(Array.isArray(body.tools) && body.tools.length > 0 && new Set(body.tools.map(row => row.path)).size === body.tools.length
    && body.tools.every(row => typeof row.path === 'string' && row.path.length > 0 && /^[a-f0-9]{64}$/.test(row.sha256)), 'proof_tools')
}
function completedMatches(actual, expected) {
  const schema = rows => rows.map(({ name, schemaSha256 }) => ({ name, schemaSha256 }))
  return hash(schema(actual)) === hash(schema(expected)) && immutable.every(name => {
    const current = actual.find(row => row.name === name), previous = expected.find(row => row.name === name)
    return current?.rows === previous?.rows && current?.rowsSha256 === previous?.rowsSha256
  })
}
export async function coordinateLegacyCandlePromotion(store, plan, { apply = false } = {}) {
  const history = await store.history(), validated = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => validated.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const proof = await store.proof()
  validateProof(proof, plan, await store.identity())
  await store.verifyTools(proof.tools)
  await store.verifyBackfillProof(proof.backfillProofHash)
  const ids = new Set(plan.prior.steps.map(step => step.id)), priorHistory = history.filter(row => ids.has(row.id))
  const entry = validated.get(plan.step.id), actual = await store.snapshot()
  if (entry?.status === 'completed') {
    check(completedMatches(actual, proof.after), 'completed_state_conflict')
    await store.verifyPrior('promoted', priorHistory)
    return { status: 'completed', ddlCount: 0 }
  }
  const before = hash(actual) === hash(proof.before), after = hash(actual) === hash(proof.after)
  check(before || after, 'state_conflict'); check(entry || !after, 'unrecorded_promotion')
  await store.verifyPrior(after ? 'promoted' : 'original', priorHistory)
  if (!apply) return { status: after ? 'reconcile' : 'pending', ddlCount: 0 }
  if (!entry) {
    try { await store.begin(plan.step) } catch (cause) { throw Error('legacy_candle_promotion_begin_unknown', { cause }) }
  }
  let ddlCount = 0
  if (!after) {
    check(hash(await store.snapshot()) === hash(proof.before), 'precondition_changed')
    try { await store.execute(plan.step.sql); ddlCount++ } catch (cause) { throw Error('legacy_candle_promotion_ddl_unknown', { cause }) }
  }
  check(hash(await store.snapshot()) === hash(proof.after), 'postcondition_failed')
  await store.verifyPrior('promoted', priorHistory)
  try { await store.complete(plan.step) } catch (cause) { throw Error('legacy_candle_promotion_complete_unknown', { cause }) }
  return { status: after ? 'reconciled' : 'applied', ddlCount }
}
