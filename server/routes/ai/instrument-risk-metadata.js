// Risk-snapshot instrument metadata validation and audit evidence.

const REQUIRED_NUMERIC_FIELDS = [
  'tick_value', 'tick_size', 'contract_size', 'volume_min', 'volume_max',
  'volume_step', 'digits', 'point', 'trade_mode',
]

const POSITIVE_FIELDS = [
  'tick_value', 'tick_size', 'contract_size', 'volume_min', 'volume_max',
  'volume_step', 'point',
]

const CANDIDATE_FIELDS = [
  'tick_size_raw_marketinfo',
  'tick_size_marketinfo_price_candidate',
  'tick_size_symbolinfo_candidate',
]

const ACCEPTED_VALIDATION_STATUSES = new Set(['valid', 'consistent', 'fallback', 'legacy'])
const REJECTED_VALIDATION_STATUSES = new Set(['ambiguous', 'invalid'])
const EPSILON = 1e-9

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== ''
}

function isNearlyInteger(value) {
  return Math.abs(value - Math.round(value)) <= Math.max(1e-7, Math.abs(value) * 1e-9)
}

function addReason(reasons, code, details = {}) {
  reasons.push({ code, ...details })
}

function normalizedStatus(value) {
  const status = String(value ?? '').trim().toLowerCase()
  return status || null
}

function metadataEvidence(instrument, context = {}) {
  const raw = instrument && typeof instrument === 'object' ? instrument : {}
  const snapshot = context.snapshot && typeof context.snapshot === 'object' ? context.snapshot : {}
  const account = context.account && typeof context.account === 'object' ? context.account : {}
  return {
    platform: raw.platform || snapshot.platform || snapshot.source || account.platform || account.platform_name || null,
    bridge_version: raw.bridge_version || raw.client_version || snapshot.bridge_version || snapshot.client_version || account.bridge_version || account.client_version || null,
    ea_version: raw.ea_version || snapshot.ea_version || account.ea_version || null,
    tick_size: finiteNumber(raw.tick_size),
    tick_value: finiteNumber(raw.tick_value),
    point: finiteNumber(raw.point),
    contract_size: finiteNumber(raw.contract_size),
    digits: finiteNumber(raw.digits),
    volume_min: finiteNumber(raw.volume_min),
    volume_max: finiteNumber(raw.volume_max),
    volume_step: finiteNumber(raw.volume_step),
    tick_size_source: String(raw.tick_size_source || '').trim() || null,
    tick_size_raw_marketinfo: hasValue(raw.tick_size_raw_marketinfo) ? finiteNumber(raw.tick_size_raw_marketinfo) : null,
    tick_size_marketinfo_price_candidate: hasValue(raw.tick_size_marketinfo_price_candidate)
      ? finiteNumber(raw.tick_size_marketinfo_price_candidate) : null,
    tick_size_symbolinfo_candidate: hasValue(raw.tick_size_symbolinfo_candidate)
      ? finiteNumber(raw.tick_size_symbolinfo_candidate) : null,
    instrument_validation_status: normalizedStatus(raw.instrument_validation_status) || 'legacy',
  }
}

function normalizeInstrument(raw) {
  if (!raw || typeof raw !== 'object') return null
  const instrument = { ...raw }
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    if (hasValue(raw[field])) instrument[field] = Number(raw[field])
  }
  for (const field of CANDIDATE_FIELDS) {
    if (hasValue(raw[field])) instrument[field] = Number(raw[field])
  }
  return instrument
}

/**
 * Validate the final instrument contract used by evaluateCoreRisk.
 *
 * A missing instrument validation status is intentionally treated as legacy:
 * old MT5/Bridge snapshots remain compatible, while the core risk fields are
 * still checked. New Bridge evidence statuses are fail-closed when ambiguous
 * or invalid, and candidate fields are retained for later audit inspection.
 */
export function validateRiskInstrument(rawInstrument, context = {}) {
  const raw = rawInstrument && typeof rawInstrument === 'object' ? rawInstrument : null
  const instrument = normalizeInstrument(raw)
  const reasons = []
  const warnings = []
  const status = normalizedStatus(raw?.instrument_validation_status)
  const evidence = metadataEvidence(raw, context)

  if (!raw) {
    addReason(reasons, 'instrument_missing')
  }

  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const value = finiteNumber(raw?.[field])
    if (value === null) addReason(reasons, 'field_not_finite', { field })
  }

  for (const field of POSITIVE_FIELDS) {
    const value = finiteNumber(raw?.[field])
    if (value !== null && value <= 0) addReason(reasons, 'field_not_positive', { field, value })
  }

  const digits = finiteNumber(raw?.digits)
  if (digits !== null && (!Number.isInteger(digits) || digits < 0 || digits > 10)) {
    addReason(reasons, 'digits_invalid', { digits })
  }

  const volumeMin = finiteNumber(raw?.volume_min)
  const volumeMax = finiteNumber(raw?.volume_max)
  const volumeStep = finiteNumber(raw?.volume_step)
  if (volumeMin !== null && volumeMax !== null && volumeMin > volumeMax) {
    addReason(reasons, 'volume_range_invalid', { volume_min: volumeMin, volume_max: volumeMax })
  }
  if (volumeMin !== null && volumeMax !== null && volumeStep !== null && volumeStep > 0) {
    const latticeSpan = (volumeMax - volumeMin) / volumeStep
    if (!isNearlyInteger(latticeSpan)) {
      addReason(reasons, 'volume_lattice_invalid', {
        volume_min: volumeMin, volume_max: volumeMax, volume_step: volumeStep,
      })
    }
  }

  const point = finiteNumber(raw?.point)
  const tickSize = finiteNumber(raw?.tick_size)
  if (digits !== null && Number.isInteger(digits) && digits >= 0 && point !== null && point > 0) {
    const minimumPriceUnit = 10 ** -digits
    if (point + EPSILON < minimumPriceUnit) {
      addReason(reasons, 'point_below_digits_precision', { point, digits, minimum_price_unit: minimumPriceUnit })
    }
    if (tickSize !== null && tickSize > 0 && tickSize + EPSILON < minimumPriceUnit) {
      addReason(reasons, 'tick_size_below_digits_precision', { tick_size: tickSize, digits, minimum_price_unit: minimumPriceUnit })
    }
    if (tickSize !== null && tickSize > 0 && !isNearlyInteger(tickSize / point)) {
      addReason(reasons, 'tick_size_not_aligned_to_point', { tick_size: tickSize, point })
    }
  }

  if (status && REJECTED_VALIDATION_STATUSES.has(status)) {
    addReason(reasons, 'bridge_validation_status_rejected', { status })
  } else if (status && !ACCEPTED_VALIDATION_STATUSES.has(status)) {
    addReason(reasons, 'bridge_validation_status_unknown', { status })
  }

  for (const field of CANDIDATE_FIELDS) {
    if (!hasValue(raw?.[field])) continue
    const value = finiteNumber(raw[field])
    if (value === null || value <= 0) addReason(warnings, 'tick_size_candidate_unavailable', { field, value: raw[field] })
  }

  const bridgeReasons = Array.isArray(raw?.instrument_validation_reasons)
    ? raw.instrument_validation_reasons
    : []
  const validationReasons = [...bridgeReasons, ...warnings, ...reasons]
  const validationStatus = reasons.length ? 'invalid' : (status || 'legacy')
  const validatedInstrument = instrument
    ? {
      ...instrument,
      instrument_validation_status: validationStatus,
      instrument_validation_reasons: validationReasons,
    }
    : null

  return {
    valid: reasons.length === 0,
    status: validationStatus,
    reasons,
    warnings,
    validation_reasons: validationReasons,
    evidence,
    instrument: validatedInstrument,
  }
}
