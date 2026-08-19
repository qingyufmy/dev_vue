import { withTransaction } from '../../db.js'

// A candle persistence event can arrive much sooner than the regular review
// scheduler tick. Wake only the already-queued evidence lane; the normal cycle
// still rebuilds and validates the complete evidence before a model worker can
// claim anything. The short in-process debounce prevents one candle batch from
// starting a retry storm across timeframes.
const WAKE_DEBOUNCE_MS = 30 * 1000
const WAKE_LIMIT = 25
const wakeState = new Map()

function wakeKey({ sourceId = null, standardSymbol = '', timeframe = '' } = {}) {
  // Market candles are shared evidence. Aggregate all sources and timeframes
  // for one standard symbol into one wake window so parallel Bridge sources or
  // an M5/M15/H1/H4 batch cannot repeatedly wake the same review cases.
  return String(standardSymbol || '').trim().toUpperCase()
}

export function resetPeriodReviewEvidenceWakeState() {
  wakeState.clear()
}

export async function wakePeriodReviewEvidenceWaiters({ sourceId = null, standardSymbol = '', timeframe = '',
  requestCycle = null, nowUtcMs = Date.now(), limit = WAKE_LIMIT } = {}) {
  if (!Number(sourceId) || !String(standardSymbol || '').trim() || !String(timeframe || '').trim()) {
    return { woken:0, skipped:'invalid_market_event' }
  }
  const key = wakeKey({ sourceId, standardSymbol, timeframe })
  const lastWake = Number(wakeState.get(key) || 0)
  if (Number(nowUtcMs) - lastWake < WAKE_DEBOUNCE_MS) return { woken:0, skipped:'debounced' }
  wakeState.set(key, Number(nowUtcMs))
  const now = new Date(Number(nowUtcMs) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)
  const boundedLimit = Math.max(1, Math.min(WAKE_LIMIT, Math.trunc(Number(limit) || WAKE_LIMIT)))
  const symbol = standardSymbol.trim().toUpperCase()
  const frame = timeframe.trim().toUpperCase()
  const result = await withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.id
        FROM period_review_jobs jobs
        JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      WHERE jobs.job_type = 'daily_review' AND jobs.job_slot = 0 AND jobs.status = 'queued'
        AND jobs.last_error_code = 'period_market_incomplete' AND jobs.lease_token IS NULL
        AND cases.current_version_id IS NULL AND cases.evidence_status <> 'complete'
        AND JSON_EXTRACT(IF(JSON_VALID(cases.evidence_json), cases.evidence_json, '{}'),
          CONCAT('$.period_market.symbols.', ?, '.', ?)) IS NOT NULL
        AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at > ?)
      ORDER BY jobs.next_attempt_at ASC, jobs.id ASC LIMIT ? FOR UPDATE`, [symbol, frame, now, boundedLimit])
    const ids = (Array.isArray(rows) ? rows : []).map(row => Number(row?.id)).filter(Number.isSafeInteger)
    if (!ids.length) return { affectedRows:0, selectedIds:[] }
    const placeholders = ids.map(() => '?').join(',')
    // The selection is bounded and ordered above. Recheck the entire lane in
    // the update so a concurrent scheduler/case refresh cannot wake a row
    // that stopped being an evidence-retry waiter after it was selected.
    const [updated] = await run(`UPDATE period_review_jobs jobs
        JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      SET jobs.next_attempt_at = ?, jobs.progress_stage = 'evidence_retry_wait',
        jobs.stage_updated_at = ?, jobs.updated_at = ?
      WHERE jobs.id IN (${placeholders})
        AND jobs.job_type = 'daily_review' AND jobs.job_slot = 0 AND jobs.status = 'queued'
        AND jobs.last_error_code = 'period_market_incomplete' AND jobs.lease_token IS NULL
        AND cases.current_version_id IS NULL AND cases.evidence_status <> 'complete'
        AND JSON_EXTRACT(IF(JSON_VALID(cases.evidence_json), cases.evidence_json, '{}'),
          CONCAT('$.period_market.symbols.', ?, '.', ?)) IS NOT NULL
        AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at > ?)`,
    [now, now, now, ...ids, symbol, frame, now])
    return { affectedRows:Number(updated?.affectedRows ?? updated?.changes ?? 0), selectedIds:ids }
  })
  const woken = Number(result?.affectedRows || 0)
  if (woken > 0) {
    if (typeof requestCycle === 'function') requestCycle()
    else import('./period-review.js').then(module => module.requestPeriodReviewCycle()).catch(error => {
      console.error('[PeriodReview] evidence wake failed:', error?.message || error)
    })
  }
  return { woken, sourceId:Number(sourceId), standardSymbol:symbol, timeframe:frame }
}
