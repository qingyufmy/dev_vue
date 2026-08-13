// Execution eligibility is an independent, persisted decision.  It must not
// be inferred from the model's signal_type, narrative, or risk result.

export const EXECUTION_VALIDATION_STATUSES = Object.freeze([
  'eligible', 'ineligible', 'invalid_output',
])

const REASON_CODE = /^[a-z][a-z0-9_.:-]{0,127}$/

function parseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeReasonCodes(value) {
  if (value == null) return []
  if (!Array.isArray(value)) return null
  const result = []
  for (const item of value) {
    const code = String(item || '').trim().toLowerCase()
    if (!code || !REASON_CODE.test(code)) return null
    if (!result.includes(code)) result.push(code)
  }
  return result.slice(0, 16)
}

function invalidValidation(reason = 'execution_validation_invalid') {
  return {
    status:'invalid_output',
    eligible:false,
    reason_codes:[reason],
  }
}

/**
 * Normalize an explicitly supplied validation object.  Malformed explicit
 * output is never treated as a legacy signal: it becomes invalid_output and
 * therefore fails closed at every execution boundary.
 */
export function normalizeExecutionValidation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidValidation()
  }
  const status = String(value.status || '').trim().toLowerCase()
  const reasonCodes = normalizeReasonCodes(value.reason_codes)
  if (!EXECUTION_VALIDATION_STATUSES.includes(status)) return invalidValidation('execution_validation_status_invalid')
  if (reasonCodes == null) return invalidValidation('execution_validation_reason_codes_invalid')
  if (typeof value.eligible !== 'boolean') return invalidValidation('execution_validation_eligible_invalid')
  if ((status === 'eligible' && value.eligible !== true)
    || (status !== 'eligible' && value.eligible !== false)) {
    return invalidValidation('execution_validation_status_mismatch')
  }
  return { status, eligible:value.eligible, reason_codes:reasonCodes }
}

/**
 * Read validation from a signal, its decision object, or persisted
 * decision_json.  `explicit` distinguishes new records from legacy rows that
 * predate the independent validation field.
 */
export function readExecutionValidation(value, { legacyAllowed = true } = {}) {
  const source = parseJson(value) || {}
  const decision = parseJson(source.decision) || {}
  const stored = parseJson(source.decision_json) || {}
  let explicitValue
  let explicit = false
  const directValidation = Object.prototype.hasOwnProperty.call(source, 'status')
    && Object.prototype.hasOwnProperty.call(source, 'eligible')
    && Object.prototype.hasOwnProperty.call(source, 'reason_codes')
    ? source : undefined
  for (const candidate of [source.execution_validation, decision.execution_validation, stored.execution_validation, directValidation]) {
    if (candidate !== undefined) {
      explicitValue = candidate
      explicit = true
      break
    }
  }
  if (explicit) {
    const validation = normalizeExecutionValidation(explicitValue)
    return { validation, explicit:true, legacy:false }
  }
  if (!legacyAllowed) {
    return { validation:invalidValidation('execution_validation_missing'), explicit:false, legacy:true }
  }
  return {
    validation:{
      status:'eligible',
      eligible:true,
      reason_codes:['legacy_execution_validation'],
    },
    explicit:false,
    legacy:true,
  }
}

export function isExecutionEligible(value, options = {}) {
  return readExecutionValidation(value, options).validation.eligible === true
}

export function getExecutionValidation(value, options = {}) {
  return readExecutionValidation(value, options).validation
}

export function executionValidationRejection(value) {
  const state = value?.validation ? value : readExecutionValidation(value)
  const validation = state.validation || invalidValidation()
  return {
    status:'rejected',
    classification:'execution_validation_rejection',
    error_code:'execution_validation_ineligible',
    reason:'execution_validation_ineligible',
    message:'执行资格校验未通过，本次不会发送交易指令',
    details:{ execution_validation:validation },
  }
}

/** Attach only an explicit validation to a persisted decision object. */
export function attachExecutionValidationToDecision(decision = {}, signal = decision) {
  const state = readExecutionValidation(signal)
  const modelDecision = signal?.model_decision && typeof signal.model_decision === 'object'
    && !Array.isArray(signal.model_decision) ? { model_decision:signal.model_decision } : {}
  if (!state.explicit) return { ...decision, ...modelDecision }
  return { ...decision, ...modelDecision, execution_validation:state.validation }
}

/** Return a presentation-safe signal with explicit validation exposed at top level. */
export function attachExecutionValidation(signal = {}) {
  const state = readExecutionValidation(signal)
  return state.explicit ? { ...signal, execution_validation:state.validation } : { ...signal }
}
