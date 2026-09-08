import { hash } from './v4-backfill-contract.mjs'
import { validateLegacyCandleConversion } from './legacy-candle-backfill.mjs'

const check = (value, code) => { if (!value) throw Error('legacy_candle_mysql_' + code) }
const keyFields = ['trading_account_id', 'symbol', 'timeframe', 'open_time_utc']
const valueFields = [...keyFields, 'open_price', 'high_price', 'low_price', 'close_price', 'tick_volume', 'closed', 'revision']
const candleSelect = 'CAST(trading_account_id AS CHAR) trading_account_id,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,CAST(revision AS CHAR) revision'
const runSelect = 'id,conversion_plan_hash,source_plan_hash,source_rows_hash,mapping_hash,projection_hash,CAST(expected_source_rows AS CHAR) expected_source_rows,CAST(expected_projection_rows AS CHAR) expected_projection_rows,CAST(mapped_rows AS CHAR) mapped_rows,CAST(projection_rows AS CHAR) projection_rows,CAST(last_legacy_id AS CHAR) last_legacy_id,status'
const mapSelect = 'CAST(legacy_candle_id AS CHAR) legacy_candle_id,run_id,CAST(source_id AS CHAR) source_id,CAST(trading_account_id AS CHAR) trading_account_id,symbol,timeframe,open_time_utc,target_key_hash,payload_hash,source_hash'
const utc = value => {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(value), 'utc')
  const [seconds, fraction = ''] = value.split('.')
  return seconds.replace(' ', 'T') + '.' + fraction.padEnd(3, '0') + 'Z'
}
const sqlUtc = value => value.replace('T', ' ').replace(/Z$/, '')
const targetOrder = (a, b) => a.targetKeyHash.localeCompare(b.targetKeyHash)
const mapOrder = (a, b) => BigInt(a.legacyCandleId) < BigInt(b.legacyCandleId) ? -1 : BigInt(a.legacyCandleId) > BigInt(b.legacyCandleId) ? 1 : 0
const targetKey = target => hash(keyFields.map(field => target[field]))
const projected = ({ targetKeyHash, payloadHash, target }) => ({ targetKeyHash, payloadHash, target })
export function decodeLegacyCandleProjection(row) {
  check(row.closed === 0 || row.closed === 1, 'closed')
  const target = Object.fromEntries(valueFields.map(field => [field, field === 'open_time_utc' ? utc(row[field]) : field === 'closed' ? row.closed === 1 : row[field]]))
  return { targetKeyHash: targetKey(target), payloadHash: hash(target), target }
}

// Guards are mandatory and use this same connection. verifySource must re-read
// reviewed identities and complete source rows, holding shared locks when lock=true.
// assertIdentity also verifies the durable tool/schema proof and upgrade lock.
export function mysqlLegacyCandleBackfillStore(connection, approved, { assertIdentity, verifySource }) {
  check(typeof assertIdentity === 'function' && typeof verifySource === 'function', 'guards')
  const plan = structuredClone(validateLegacyCandleConversion(approved))
  const planDigest = hash(plan)
  async function verifyPlan(candidate) {
    check(hash(candidate) === planDigest, 'plan_changed')
    await assertIdentity(connection)
    check(await verifySource(connection, { lock: false }) === plan.planHash, 'source_changed')
  }
  const metadata = row => {
    check(row.id === 1 && row.conversion_plan_hash === plan.planHash && row.source_plan_hash === plan.sourcePlanHash
      && row.source_rows_hash === plan.sourceRowsHash && row.mapping_hash === plan.mappingHash && row.projection_hash === plan.projectionHash
      && row.expected_source_rows === String(plan.inputRows) && row.expected_projection_rows === String(plan.outputRows), 'run_metadata')
    const mappedRows = Number(row.mapped_rows), projectionRows = Number(row.projection_rows)
    check(Number.isSafeInteger(mappedRows) && mappedRows >= 0 && mappedRows <= plan.inputRows
      && Number.isSafeInteger(projectionRows) && projectionRows >= 0 && projectionRows <= plan.outputRows
      && typeof row.last_legacy_id === 'string' && /^(0|[1-9]\d*)$/.test(row.last_legacy_id), 'checkpoint')
    return { status: row.status, checkpoint: { planHash: row.conversion_plan_hash, mappedRows, projectionRows, lastLegacyId: row.last_legacy_id } }
  }
  async function readRun(lock = false) {
    const [rows] = await connection.query('SELECT ' + runSelect + ' FROM legacy_candle_backfill_v4 ORDER BY id LIMIT 2' + (lock ? ' FOR UPDATE' : ''))
    check(rows.length <= 1, 'multiple_runs')
    return rows.length ? metadata(rows[0]) : null
  }
  async function readArea(lock = false) {
    const [rows] = await connection.query('SELECT ' + candleSelect + ' FROM market_candles_build_v4 ORDER BY trading_account_id,symbol,timeframe,open_time_utc LIMIT 100001' + (lock ? ' FOR UPDATE' : ''))
    const [links] = await connection.query('SELECT ' + mapSelect + ' FROM legacy_candle_mappings_v4 ORDER BY legacy_candle_id LIMIT 100001' + (lock ? ' FOR UPDATE' : ''))
    check(rows.length <= plan.outputRows && links.length <= plan.inputRows, 'area_budget')
    return { projections: rows.map(decodeLegacyCandleProjection).sort(targetOrder), mappings: links.map(row => {
      check(row.run_id === 1 && targetKey({ ...row, open_time_utc: utc(row.open_time_utc) }) === row.target_key_hash, 'mapping_key')
      return { legacyCandleId: row.legacy_candle_id, sourceId: row.source_id, targetKeyHash: row.target_key_hash, payloadHash: row.payload_hash, sourceHash: row.source_hash }
    }).sort(mapOrder) }
  }
  async function readState() {
    await assertIdentity(connection)
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      const run = await readRun(), area = await readArea()
      if (!run) { check(area.mappings.length === 0 && area.projections.length === 0, 'orphan_area'); return null }
      return { ...run, ...area }
    } finally { await connection.rollback() }
  }
  async function transaction(candidate, callback) {
    check(hash(candidate) === planDigest, 'plan_changed')
    await assertIdentity(connection)
    await connection.beginTransaction()
    try {
      const run = await readRun(true)
      check(await verifySource(connection, { lock: true }) === plan.planHash, 'source_changed')
      await callback(run)
      await assertIdentity(connection)
      await connection.commit()
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
  }
  function expectedState(size, status = 'filling') {
    const mappings = plan.mappings.slice(0, size), keys = new Set(mappings.map(row => row.targetKeyHash))
    return { status, planHash: plan.planHash, mappedRows: size, projectionRows: keys.size, lastLegacyId: mappings.at(-1)?.legacyCandleId ?? '0' }
  }
  const flatten = run => ({ status: run.status, ...run.checkpoint })
  return {
    verifyPlan, readState,
    async verifyEmpty() { check(await readState() === null, 'not_empty') },
    async applyBatch(candidate, previous, batch) {
      const start = previous.mappedRows, count = batch.mappings.length
      check(Number.isSafeInteger(start) && start >= 0 && count <= 500 && start + count <= plan.inputRows, 'batch_budget')
      const expected = expectedState(start, previous.status)
      check(hash(expected) === hash(previous) && ['pending', 'filling'].includes(previous.status)
        && (previous.status !== 'pending' || start === 0), 'expected_checkpoint')
      check(hash(batch.mappings) === hash(plan.mappings.slice(start, start + count)), 'batch_mappings')
      const keys = new Set(batch.mappings.map(row => row.targetKeyHash))
      const projections = plan.projections.filter(row => keys.has(row.targetKeyHash)).map(projected).sort(targetOrder)
      check(hash(batch.projections) === hash(projections), 'batch_projections')
      const { status, ...next } = expectedState(start + count)
      check(hash(next) === hash(batch.checkpoint), 'batch_checkpoint')
      await transaction(candidate, async run => {
        if (run) check(hash(flatten(run)) === hash(previous), 'checkpoint_conflict')
        else {
          check(previous.status === 'pending', 'missing_checkpoint')
          const area = await readArea(true)
          check(!area.mappings.length && !area.projections.length, 'orphan_area')
          await connection.execute("INSERT INTO legacy_candle_backfill_v4 (id,conversion_plan_hash,source_plan_hash,source_rows_hash,mapping_hash,projection_hash,expected_source_rows,expected_projection_rows,created_at_utc,updated_at_utc) VALUES (1,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
            [plan.planHash, plan.sourcePlanHash, plan.sourceRowsHash, plan.mappingHash, plan.projectionHash, plan.inputRows, plan.outputRows])
        }
        let inserted = 0
        if (projections.length) {
          const parameters = projections.flatMap(row => keyFields.map(field => field === 'open_time_utc' ? sqlUtc(row.target[field]) : row.target[field]))
          const [existing] = await connection.execute('SELECT ' + candleSelect + ' FROM market_candles_build_v4 WHERE (trading_account_id,symbol,timeframe,open_time_utc) IN (' + projections.map(() => '(?,?,?,?)').join(',') + ') FOR UPDATE', parameters)
          const found = new Map(existing.map(row => { const item = decodeLegacyCandleProjection(row); return [item.targetKeyHash, item] }))
          for (const row of projections) if (found.has(row.targetKeyHash)) check(hash(found.get(row.targetKeyHash)) === hash(row), 'existing_projection_conflict')
          const missing = projections.filter(row => !found.has(row.targetKeyHash))
          inserted = missing.length
          if (missing.length) await connection.execute('INSERT INTO market_candles_build_v4 (' + valueFields.join(',') + ') VALUES ' + missing.map(() => '(' + valueFields.map(() => '?').join(',') + ')').join(','),
            missing.flatMap(row => valueFields.map(field => field === 'open_time_utc' ? sqlUtc(row.target[field]) : field === 'closed' ? Number(row.target[field]) : row.target[field])))
        }
        check(previous.projectionRows + inserted === next.projectionRows, 'projection_count_conflict')
        if (count) {
          const targets = new Map(projections.map(row => [row.targetKeyHash, row.target]))
          await connection.execute('INSERT INTO legacy_candle_mappings_v4 (legacy_candle_id,run_id,source_id,trading_account_id,symbol,timeframe,open_time_utc,target_key_hash,payload_hash,source_hash) VALUES ' + batch.mappings.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(','),
            batch.mappings.flatMap(row => { const t = targets.get(row.targetKeyHash); return [row.legacyCandleId, 1, row.sourceId, t.trading_account_id, t.symbol, t.timeframe, sqlUtc(t.open_time_utc), row.targetKeyHash, row.payloadHash, row.sourceHash] }))
        }
        const [result] = await connection.execute("UPDATE legacy_candle_backfill_v4 SET mapped_rows=?,projection_rows=?,last_legacy_id=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=1 AND conversion_plan_hash=? AND status='filling' AND mapped_rows=? AND projection_rows=? AND last_legacy_id=?",
          [next.mappedRows, next.projectionRows, next.lastLegacyId, plan.planHash, previous.mappedRows, previous.projectionRows, previous.lastLegacyId])
        check(result.affectedRows === 1, 'checkpoint_update_conflict')
      })
    },
    async markVerified(candidate, expected) {
      check(hash(expected) === hash(expectedState(plan.inputRows)), 'incomplete')
      await transaction(candidate, async run => {
        check(run && hash(flatten(run)) === hash(expected), 'checkpoint_conflict')
        const area = await readArea(true)
        check(hash(area.mappings) === plan.mappingHash
          && hash(area.projections) === hash(plan.projections.map(projected).sort(targetOrder)), 'final_content_conflict')
        const [result] = await connection.execute("UPDATE legacy_candle_backfill_v4 SET status='verified',updated_at_utc=UTC_TIMESTAMP(3) WHERE id=1 AND conversion_plan_hash=? AND status='filling'", [plan.planHash])
        check(result.affectedRows === 1, 'verification_conflict')
      })
    },
  }
}
