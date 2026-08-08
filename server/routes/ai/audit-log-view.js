const RECOVERY_ACTION_CODES = new Set([
  'ai_delivery_recovery_skipped',
  'ai_delivery_recovery_summary',
])

const LEGACY_GENERIC_ACTION = '系统审计操作'
const LEGACY_GENERIC_REASON = '系统执行条件未满足'
const LEGACY_RECOVERY_REASON = '历史信号恢复条件未满足（旧记录未保留具体原因）'
const DEFAULT_COLLAPSE_WINDOW_MS = 5 * 60 * 1000

function positiveCount(value, fallback = 1) {
  const count = Number(value)
  return Number.isInteger(count) && count > 0 ? count : fallback
}

function auditTimeUtcMsc(row) {
  const value = Number(row?.created_at_utc_msc)
  return Number.isFinite(value) && value > 0 ? value : null
}

function recoveryReason(row) {
  return String(row?.result?.reason || row?.request?.reason || '').trim()
}

function recoveryOccurrenceCount(row) {
  return positiveCount(row?.repeat_count,
    positiveCount(row?.result?.count, positiveCount(row?.request?.count, 1)))
}

export function isRecoveryCleanupAudit(row) {
  const actionCode = String(row?.action_code || '').trim().toLowerCase()
  if (RECOVERY_ACTION_CODES.has(actionCode)) return true

  // Compatibility for the already-persisted recovery flood. Older rows lost
  // their action/reason codes during write-time localization, but retain the
  // delivery evidence that distinguishes them from normal audit events.
  const request = row?.request || {}
  const result = row?.result || {}
  const statusCode = String(row?.status_code || '').trim().toLowerCase()
  return String(row?.action || '').trim() === LEGACY_GENERIC_ACTION
    && (statusCode === 'info' || String(row?.status || '').trim() === '信息')
    && request.signal_id != null
    && request.delivery_id != null
    && String(request.reason || '').trim() === LEGACY_GENERIC_REASON
    && String(result.reason || '').trim() === LEGACY_GENERIC_REASON
}

function recoveryFingerprint(row) {
  const actionCode = RECOVERY_ACTION_CODES.has(String(row?.action_code || '').trim().toLowerCase())
    ? String(row.action_code).trim().toLowerCase()
    : 'legacy_delivery_recovery'
  return [
    actionCode,
    String(row?.symbol || '').trim().toUpperCase(),
    String(row?.status_code || row?.status || '').trim().toLowerCase(),
    recoveryReason(row),
  ].join('|')
}

/**
 * Collapse only consecutive delivery-recovery cleanup noise. The underlying
 * rows remain intact in MySQL and delivery execution_result remains the source
 * for per-signal evidence.
 */
export function collapseRecoveryAuditRows(rows, { windowMs = DEFAULT_COLLAPSE_WINDOW_MS } = {}) {
  const source = Array.isArray(rows) ? rows : []
  const collapsed = []
  let activeGroup = null

  for (const row of source) {
    const timestamp = auditTimeUtcMsc(row)
    if (!isRecoveryCleanupAudit(row)) {
      collapsed.push(row)
      activeGroup = null
      continue
    }

    const fingerprint = recoveryFingerprint(row)
    const canMerge = activeGroup
      && activeGroup.fingerprint === fingerprint
      && timestamp != null
      && activeGroup.oldestUtcMsc != null
      && activeGroup.oldestUtcMsc - timestamp <= windowMs

    if (!canMerge) {
      const occurrenceCount = recoveryOccurrenceCount(row)
      const legacyRow = String(row?.action_code || '').trim().toLowerCase() === 'unknown'
        && String(row?.action || '').trim() === LEGACY_GENERIC_ACTION
      const displayRow = legacyRow ? {
        ...row,
        action:'历史信号恢复跳过',
        action_code:'ai_delivery_recovery_skipped',
        request:{ ...(row.request || {}), reason:LEGACY_RECOVERY_REASON },
        result:{ ...(row.result || {}), reason:LEGACY_RECOVERY_REASON },
      } : row
      const grouped = {
        ...displayRow,
        repeat_count:occurrenceCount,
        repeat_grouped_rows:1,
        repeat_from_utc_msc:timestamp,
        repeat_to_utc_msc:timestamp,
      }
      collapsed.push(grouped)
      activeGroup = {
        row:grouped,
        fingerprint,
        oldestUtcMsc:timestamp,
      }
      continue
    }

    activeGroup.row.repeat_count += recoveryOccurrenceCount(row)
    activeGroup.row.repeat_grouped_rows += 1
    if (timestamp != null) {
      activeGroup.oldestUtcMsc = timestamp
      activeGroup.row.repeat_from_utc_msc = timestamp
    }
  }

  return collapsed
}
