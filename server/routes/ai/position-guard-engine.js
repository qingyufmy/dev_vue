/**
 * Pure PivotGuard calculation engine.
 *
 * This module deliberately has no application or I/O dependencies.  It accepts
 * one complete market snapshot and returns one deterministic candidate action.
 * The caller is responsible for persistence, execution, reconciliation and
 * advancing the returned stage state only after the broker confirms an action.
 */

export const PIVOT_METHODS = Object.freeze({
  FIBONACCI: 'fibonacci',
  STANDARD: 'standard',
})

export const ACTION_TYPES = Object.freeze({
  OBSERVE: 'observe',
  FULL_EXIT: 'full_exit',
  PARTIAL_EXIT: 'partial_exit',
  MOVE_PROTECTION: 'move_protection',
})

export const REASON_CODES = Object.freeze({
  NONE: 'none',
  PIVOT_CROSS_STOP: 'pivot_cross_stop',
  PIVOT_CROSS_PENDING: 'pivot_cross_pending',
  RETRACE_STOP: 'retrace_stop',
  BREAK_STOP: 'break_stop',
  PIVOT_TAKE_PROFIT: 'pivot_take_profit',
  FIRST_TARGET_TAKE_PROFIT: 'first_target_take_profit',
  BREAK_EVEN: 'break_even',
  BREAK_EVEN_PENDING: 'break_even_pending',
  PROTECTION_ALREADY_STRICTER: 'protection_already_stricter',
  PROTECTION_NOT_READY: 'protection_not_ready',
})

const EPSILON = 1e-9
const DEFAULT_PIVOT_BE_MULTIPLIER = 2

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function failure(code, details = {}) {
  return { ok: false, error: { code, ...details } }
}

function success(value) {
  return { ok: true, ...value }
}

function normalizeMethod(value) {
  if (typeof value !== 'string') return null
  const method = value.trim().toLowerCase()
  if (method === PIVOT_METHODS.FIBONACCI || method === 'fib') return PIVOT_METHODS.FIBONACCI
  if (method === PIVOT_METHODS.STANDARD || method === 'classic') return PIVOT_METHODS.STANDARD
  return null
}

function readFinite(value, { min = null, max = null, integer = false } = {}) {
  if (!isFiniteNumber(value)) return null
  if (min !== null && value < min) return null
  if (max !== null && value > max) return null
  if (integer && !Number.isInteger(value)) return null
  return value
}

function readNonNegative(value) {
  return readFinite(value, { min: 0 })
}

function readPositive(value) {
  return readFinite(value, { min: Number.MIN_VALUE })
}

function readOptionalPrice(value) {
  if (value === null || value === undefined || value === 0) return null
  return readPositive(value)
}

function readFirst(object, keys) {
  for (const key of keys) {
    if (hasOwn(object, key) && object[key] !== undefined) return object[key]
  }
  return undefined
}

function normalizeDirection(value) {
  if (typeof value === 'string') {
    const direction = value.trim().toLowerCase()
    if (direction === 'buy' || direction === 'long') return 'buy'
    if (direction === 'sell' || direction === 'short') return 'sell'
  }
  if (value === 1) return 'buy'
  if (value === -1 || value === 0) return 'sell'
  return null
}

function normalizeTimestamp(value) {
  if (isFiniteNumber(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

function decimalsForStep(step) {
  if (!isFiniteNumber(step) || step <= 0) return 8
  const text = step.toFixed(12).replace(/0+$/, '')
  const decimalIndex = text.indexOf('.')
  return decimalIndex === -1 ? 0 : Math.min(12, text.length - decimalIndex - 1)
}

function roundTo(value, digits) {
  if (!Number.isInteger(digits)) return value
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function roundPrice(value, contract) {
  return roundTo(Math.round(value / contract.tickSize) * contract.tickSize, contract.digits)
}

function normalizeStageState(stageState) {
  if (stageState === undefined || stageState === null) {
    return success({
      state: {
        pivotCrossSinceMs: null,
        pivotTakeProfitDone: false,
        firstTargetDone: false,
        breakEvenPending: false,
        pendingBreakEvenPrice: null,
        pendingBreakEvenSource: null,
        breakEvenDone: false,
      },
    })
  }
  if (!isRecord(stageState)) return failure('invalid_stage_state')

  const readFlag = (keys, fallback = false) => {
    const value = readFirst(stageState, keys)
    if (value === undefined) return fallback
    if (typeof value === 'boolean') return value
    if (value === 0) return false
    if (value === 1) return true
    return null
  }
  const readTimestamp = (keys) => {
    const value = readFirst(stageState, keys)
    if (value === undefined || value === null) return null
    return readFinite(value, { min: 0 })
  }
  const pivotCrossSinceKeys = [
    'pivotCrossSinceMs',
    'pivot_cross_since_ms',
    'pivot_cross_since_utc_ms',
    'pivotStopSinceMs',
    'pivot_stop_since_ms',
  ]
  const pivotCrossSinceValue = readFirst(stageState, pivotCrossSinceKeys)
  const pivotCrossSinceMs = readTimestamp(pivotCrossSinceKeys)
  if (pivotCrossSinceValue !== undefined && pivotCrossSinceValue !== null
    && pivotCrossSinceMs === null) {
    return failure('invalid_stage_state_timestamp')
  }

  const pivotTakeProfitDone = readFlag([
    'pivotTakeProfitDone',
    'pivot_take_profit_done',
    'pivotTpDone',
    'pivot_tp_done',
  ])
  const firstTargetDone = readFlag([
    'firstTargetDone',
    'first_target_done',
    'targetDone',
    'target_done',
  ])
  const breakEvenPending = readFlag([
    'breakEvenPending',
    'break_even_pending',
  ])
  const breakEvenDone = readFlag([
    'breakEvenDone',
    'break_even_done',
    'beDone',
    'be_done',
  ])
  if ([pivotTakeProfitDone, firstTargetDone, breakEvenPending, breakEvenDone].includes(null)) {
    return failure('invalid_stage_state_flag')
  }

  const pendingBreakEvenPriceValue = readFirst(stageState, [
    'pendingBreakEvenPrice',
    'pending_break_even_price',
  ])
  const pendingBreakEvenPrice = pendingBreakEvenPriceValue === undefined || pendingBreakEvenPriceValue === null
    ? null
    : readPositive(pendingBreakEvenPriceValue)
  if (pendingBreakEvenPriceValue !== undefined && pendingBreakEvenPriceValue !== null && pendingBreakEvenPrice === null) {
    return failure('invalid_stage_state_price')
  }

  const sourceValue = readFirst(stageState, [
    'pendingBreakEvenSource',
    'pending_break_even_source',
    'pendingBreakEvenTrigger',
    'pending_break_even_trigger',
  ])
  const pendingBreakEvenSource = sourceValue === undefined || sourceValue === null ? null : String(sourceValue)

  return success({
    state: {
      pivotCrossSinceMs,
      pivotTakeProfitDone,
      firstTargetDone,
      breakEvenPending,
      pendingBreakEvenPrice,
      pendingBreakEvenSource,
      breakEvenDone,
    },
  })
}

/**
 * Calculate the seven levels from one complete, already-closed D1 candle.
 *
 * @returns {{ok: true, method: string, range: number, levels: object}|{ok:false,error:object}}
 */
export function calculatePivotLevels(input = {}, methodArgument = undefined) {
  if (!isRecord(input)) return failure('invalid_d1')
  const method = normalizeMethod(methodArgument ?? readFirst(input, ['method', 'pivot_method']))
  if (!method) return failure('invalid_pivot_method')

  const high = readPositive(readFirst(input, ['high', 'H']))
  const low = readPositive(readFirst(input, ['low', 'L']))
  const close = readPositive(readFirst(input, ['close', 'C']))
  if (high === null || low === null || close === null || high <= low || close < low || close > high) {
    return failure('invalid_d1_ohlc')
  }

  const range = high - low
  const pivot = (high + low + close) / 3
  let levels
  if (method === PIVOT_METHODS.FIBONACCI) {
    levels = {
      P: pivot,
      R1: pivot + 0.382 * range,
      R2: pivot + 0.618 * range,
      R3: pivot + range,
      S1: pivot - 0.382 * range,
      S2: pivot - 0.618 * range,
      S3: pivot - range,
    }
  } else {
    levels = {
      P: pivot,
      R1: 2 * pivot - low,
      S1: 2 * pivot - high,
      R2: pivot + range,
      S2: pivot - range,
      R3: high + 2 * (pivot - low),
      S3: low - 2 * (high - pivot),
    }
  }
  return success({
    method,
    range,
    levels,
    ...levels,
  })
}

export const computePivotLevels = calculatePivotLevels

function readSection(params, name) {
  const section = params[name]
  return isRecord(section) ? section : null
}

function validateRuleSection(params, sectionName, fields) {
  const section = readSection(params, sectionName)
  if (!section) return failure('invalid_config_section', { section: sectionName })
  for (const key of Object.keys(section)) {
    if (!['enabled', ...fields].includes(key)) {
      return failure('invalid_config_field', { field: `${sectionName}.${key}` })
    }
  }
  if (typeof section.enabled !== 'boolean') {
    return failure('invalid_config_enabled', { section: sectionName })
  }
  const normalized = { enabled: section.enabled }
  for (const field of fields) {
    const value = readNonNegative(section[field])
    if (value === null) return failure('invalid_config_distance', { section: sectionName, field })
    normalized[field] = value
  }
  return success({ section: normalized })
}

function validateTakeProfitSection(params, sectionName, fields) {
  const section = readSection(params, sectionName)
  if (!section) return failure('invalid_config_section', { section: sectionName })
  for (const key of Object.keys(section)) {
    if (!['enabled', ...fields, 'close_percent', 'move_break_even'].includes(key)) {
      return failure('invalid_config_field', { field: `${sectionName}.${key}` })
    }
  }
  if (typeof section.enabled !== 'boolean') {
    return failure('invalid_config_enabled', { section: sectionName })
  }
  const normalized = { enabled: section.enabled }
  for (const field of fields) {
    const value = readNonNegative(section[field])
    if (value === null) return failure('invalid_config_distance', { section: sectionName, field })
    normalized[field] = value
  }
  const closePercent = readFinite(section.close_percent, { min: Number.MIN_VALUE, max: 100 })
  if (closePercent === null) return failure('invalid_config_close_percent', { section: sectionName })
  normalized.close_percent = closePercent
  if (typeof section.move_break_even !== 'boolean') {
    return failure('invalid_config_move_break_even', { section: sectionName })
  }
  normalized.move_break_even = section.move_break_even
  return success({ section: normalized })
}

/**
 * Validate and normalize the versioned administrator profile.
 * No defaults are inserted here: an incomplete profile is unsafe to evaluate.
 */
export function validatePositionGuardParams(params) {
  if (!isRecord(params)) return failure('invalid_config')
  const allowedTopLevel = new Set([
    'pivot_method',
    'method',
    'break_stop',
    'pivot_cross_stop',
    'retrace_stop',
    'pivot_take_profit',
    'first_target_take_profit',
  ])
  for (const key of Object.keys(params)) {
    if (!allowedTopLevel.has(key)) return failure('invalid_config_field', { field: key })
  }
  const pivotMethod = normalizeMethod(readFirst(params, ['pivot_method', 'method']))
  if (!pivotMethod) return failure('invalid_pivot_method')

  const breakStop = validateRuleSection(params, 'break_stop', ['distance_price', 'open_near_price'])
  if (!breakStop.ok) return breakStop
  const pivotCross = validateRuleSection(params, 'pivot_cross_stop', [
    'distance_price',
    'min_duration_seconds',
  ])
  if (!pivotCross.ok) return pivotCross
  if (!Number.isInteger(pivotCross.section.min_duration_seconds)) {
    return failure('invalid_config_duration', { section: 'pivot_cross_stop' })
  }
  const retraceStop = validateRuleSection(params, 'retrace_stop', ['distance_price'])
  if (!retraceStop.ok) return retraceStop
  const pivotTakeProfit = validateTakeProfitSection(params, 'pivot_take_profit', ['tolerance_price'])
  if (!pivotTakeProfit.ok) return pivotTakeProfit
  const firstTarget = validateTakeProfitSection(params, 'first_target_take_profit', [
    'tolerance_price',
    'break_even_offset_price',
  ])
  if (!firstTarget.ok) return firstTarget

  return success({
    params: {
      pivot_method: pivotMethod,
      break_stop: breakStop.section,
      pivot_cross_stop: pivotCross.section,
      retrace_stop: retraceStop.section,
      pivot_take_profit: pivotTakeProfit.section,
      first_target_take_profit: firstTarget.section,
    },
  })
}

function normalizePosition(position) {
  if (!isRecord(position)) return failure('invalid_position')
  const ticket = position.ticket
  const validTicket = (typeof ticket === 'string' && ticket.trim().length > 0)
    || (isFiniteNumber(ticket) && ticket >= 0)
  if (!validTicket) return failure('invalid_position_ticket')
  if (typeof position.symbol !== 'string' || !position.symbol.trim()) {
    return failure('invalid_position_symbol')
  }
  const direction = normalizeDirection(position.direction)
  if (!direction) return failure('invalid_position_direction')
  const open = readPositive(readFirst(position, ['open', 'open_price', 'openPrice']))
  const current = readPositive(readFirst(position, ['current', 'current_price', 'currentPrice']))
  const volume = readPositive(readFirst(position, ['volume', 'lots']))
  if (open === null || current === null || volume === null) return failure('invalid_position_price_or_volume')
  const slValue = readFirst(position, ['sl', 'stop_loss', 'stopLoss'])
  const tpValue = readFirst(position, ['tp', 'take_profit', 'takeProfit'])
  const sl = readOptionalPrice(slValue)
  const tp = readOptionalPrice(tpValue)
  if (slValue !== undefined && slValue !== null && slValue !== 0 && sl === null) {
    return failure('invalid_position_sl')
  }
  if (tpValue !== undefined && tpValue !== null && tpValue !== 0 && tp === null) {
    return failure('invalid_position_tp')
  }
  return success({
    position: {
      ticket,
      symbol: position.symbol.trim(),
      direction,
      open,
      current,
      sl,
      tp,
      volume,
    },
  })
}

function normalizeQuote(quote) {
  if (!isRecord(quote)) return failure('invalid_quote')
  const bid = readPositive(readFirst(quote, ['bid', 'Bid']))
  const ask = readPositive(readFirst(quote, ['ask', 'Ask']))
  if (bid === null || ask === null || ask < bid) return failure('invalid_quote_prices')
  return success({ quote: { bid, ask } })
}

function normalizeContract(contract) {
  if (!isRecord(contract)) return failure('invalid_contract')
  const point = readPositive(readFirst(contract, ['point', 'point_size', 'pointSize']))
  const volumeMin = readPositive(readFirst(contract, ['volume_min', 'volumeMin', 'min_volume']))
  const volumeStep = readPositive(readFirst(contract, ['volume_step', 'volumeStep', 'lot_step']))
  if (point === null || volumeMin === null || volumeStep === null) return failure('invalid_contract_specs')
  const digitsValue = readFirst(contract, ['price_digits', 'digits'])
  const digits = digitsValue === undefined ? decimalsForStep(point) : readFinite(digitsValue, { min: 0, max: 12, integer: true })
  if (digits === null) return failure('invalid_contract_digits')
  const tickSize = readPositive(readFirst(contract, ['tick_size', 'trade_tick_size', 'tickSize']) ?? point)
  const stops = readNonNegative(readFirst(contract, [
    'stops_level_points',
    'stopsLevelPoints',
    'stops_level',
    'trade_stops_level',
    'tradeStopsLevel',
  ]) ?? 0)
  const freeze = readNonNegative(readFirst(contract, [
    'freeze_level_points',
    'freezeLevelPoints',
    'freeze_level',
    'trade_freeze_level',
    'tradeFreezeLevel',
  ]) ?? 0)
  const minimumBreakEvenOffset = readNonNegative(readFirst(contract, [
    'minimum_break_even_offset_price',
    'minimumBreakEvenOffsetPrice',
  ]) ?? 0)
  if (tickSize === null || stops === null || freeze === null || minimumBreakEvenOffset === null) return failure('invalid_contract_distance')
  return success({
    contract: {
      point,
      volumeMin,
      volumeStep,
      tickSize,
      digits,
      stopsLevelPoints: stops,
      freezeLevelPoints: freeze,
      minimumBreakEvenOffset,
    },
  })
}

function levelsInOrder(levels) {
  return [levels.R3, levels.R2, levels.R1, levels.P, levels.S1, levels.S2, levels.S3]
}

/** Select the nearest profitable-direction level from all seven Pivot levels. */
export function findFirstTargetLevel(levels, direction, openPrice) {
  if (!isRecord(levels) || !['buy', 'sell'].includes(direction) || !isFiniteNumber(openPrice)) return null
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of levelsInOrder(levels)) {
    if (!isFiniteNumber(level)) continue
    const valid = direction === 'sell' ? level < openPrice : level > openPrice
    if (!valid) continue
    const distance = Math.abs(level - openPrice)
    if (distance < bestDistance) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

export function findRetraceKeyLevel(levels, direction, openPrice) {
  if (!isRecord(levels) || !['buy', 'sell'].includes(direction) || !isFiniteNumber(openPrice)) return null
  const candidates = direction === 'buy'
    ? [levels.R1, levels.R2, levels.R3].filter((level) => isFiniteNumber(level) && level < openPrice)
    : [levels.S1, levels.S2, levels.S3].filter((level) => isFiniteNumber(level) && level > openPrice)
  if (!candidates.length) return null
  return direction === 'buy' ? Math.max(...candidates) : Math.min(...candidates)
}

export function findBreakKeyLevel(levels, direction, openPrice, openNearPrice) {
  if (!isRecord(levels) || !['buy', 'sell'].includes(direction) || !isFiniteNumber(openPrice)) return null
  if (!isFiniteNumber(openNearPrice) || openNearPrice < 0) return null
  const candidates = direction === 'sell' ? [levels.R1, levels.R2, levels.R3] : [levels.S1, levels.S2, levels.S3]
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of candidates) {
    if (!isFiniteNumber(level)) continue
    const distance = Math.abs(level - openPrice)
    if (distance < bestDistance) {
      best = level
      bestDistance = distance
    }
  }
  return best !== null && bestDistance <= openNearPrice ? best : null
}

function canonicalState(state) {
  return {
    pivotCrossSinceMs: state.pivotCrossSinceMs,
    pivot_cross_since_utc_ms: state.pivotCrossSinceMs,
    pivotTakeProfitDone: state.pivotTakeProfitDone,
    pivot_tp_done: state.pivotTakeProfitDone,
    firstTargetDone: state.firstTargetDone,
    first_target_done: state.firstTargetDone,
    breakEvenPending: state.breakEvenPending,
    break_even_pending: state.breakEvenPending,
    pendingBreakEvenPrice: state.pendingBreakEvenPrice,
    pending_break_even_price: state.pendingBreakEvenPrice,
    pendingBreakEvenSource: state.pendingBreakEvenSource,
    pending_break_even_trigger: state.pendingBreakEvenSource,
    breakEvenDone: state.breakEvenDone,
    break_even_done: state.breakEvenDone,
  }
}

function baseEvidence(position, quote, levels) {
  return {
    ticket: position.ticket,
    symbol: position.symbol,
    direction: position.direction,
    bid: quote.bid,
    ask: quote.ask,
    close_price: position.direction === 'buy' ? quote.bid : quote.ask,
    pivot_levels: levels,
  }
}

function observe(reasonCode, state, evidence = {}, extra = {}) {
  return success({
    action: {
      type: ACTION_TYPES.OBSERVE,
      trigger_code: reasonCode,
      side_effect: false,
      ...evidence,
      ...extra,
    },
    next_stage_state: canonicalState(state),
  })
}

function fullExit(reasonCode, position, state, evidence) {
  return success({
    action: {
      type: ACTION_TYPES.FULL_EXIT,
      trigger_code: reasonCode,
      side_effect: true,
      ticket: position.ticket,
      symbol: position.symbol,
      close_percent: 100,
      close_volume: position.volume,
      ...evidence,
    },
    next_stage_state: canonicalState(state),
  })
}

function floorToStep(value, step, digits) {
  const units = Math.floor((value + EPSILON) / step)
  return roundTo(units * step, digits)
}

function normalizePartialVolume(positionVolume, closePercent, contract) {
  const requested = positionVolume * closePercent / 100
  let closeVolume = floorToStep(requested, contract.volumeStep, decimalsForStep(contract.volumeStep))
  const maxClosable = floorToStep(
    Math.max(0, positionVolume - contract.volumeMin),
    contract.volumeStep,
    decimalsForStep(contract.volumeStep),
  )
  closeVolume = Math.min(closeVolume, maxClosable)
  if (closeVolume < contract.volumeMin || closeVolume >= positionVolume) return null
  return closeVolume
}

function getBreakEvenIntent(state, params, contract, position) {
  let source = null
  let offset = null
  if (state.breakEvenPending && state.pendingBreakEvenSource) {
    source = state.pendingBreakEvenSource
  } else if (state.firstTargetDone && params.first_target_take_profit.move_break_even) {
    source = 'first_target_take_profit'
  } else if (state.pivotTakeProfitDone && params.pivot_take_profit.move_break_even) {
    source = 'pivot_take_profit'
  }
  if (!source) return null
  if (source === 'first_target_take_profit') {
    offset = params.first_target_take_profit.break_even_offset_price
  } else {
    offset = contract.minimumBreakEvenOffset || DEFAULT_PIVOT_BE_MULTIPLIER * contract.point
  }
  offset = Math.max(offset, DEFAULT_PIVOT_BE_MULTIPLIER * contract.point)
  const desired = position.direction === 'buy' ? position.open + offset : position.open - offset
  return {
    source,
    offset,
    desired: roundPrice(desired, contract),
  }
}

function nextProtectionForStage(state, params, contract, position, stage) {
  const preview = {
    ...state,
    pivotTakeProfitDone: stage === 'pivot_take_profit' ? true : state.pivotTakeProfitDone,
    firstTargetDone: stage === 'first_target_take_profit' ? true : state.firstTargetDone,
    breakEvenPending: false,
    pendingBreakEvenPrice: null,
    pendingBreakEvenSource: null,
  }
  const intent = getBreakEvenIntent(preview, params, contract, position)
  if (!intent) return { state: preview, protection: null }
  return {
    state: {
      ...preview,
      breakEvenPending: true,
      pendingBreakEvenPrice: intent.desired,
      pendingBreakEvenSource: intent.source,
      breakEvenDone: false,
    },
    protection: {
      type: ACTION_TYPES.MOVE_PROTECTION,
      trigger_code: REASON_CODES.BREAK_EVEN,
      trigger: REASON_CODES.BREAK_EVEN,
      side_effect: false,
      price: intent.desired,
      source_stage: intent.source,
    },
  }
}

function takeProfitAction(reasonCode, position, state, params, contract, stage, targetLevel, levels) {
  const config = stage === 'pivot_take_profit'
    ? params.pivot_take_profit
    : params.first_target_take_profit
  const stageState = {
    ...state,
    pivotTakeProfitDone: stage === 'pivot_take_profit' ? true : state.pivotTakeProfitDone,
    firstTargetDone: stage === 'first_target_take_profit' ? true : state.firstTargetDone,
  }
  const base = {
    ticket: position.ticket,
    symbol: position.symbol,
    close_percent: config.close_percent,
    target_level: targetLevel,
    stage,
  }
  if (config.close_percent >= 100) {
    return fullExit(reasonCode, position, stageState, base)
  }

  const closeVolume = normalizePartialVolume(position.volume, config.close_percent, contract)
  if (closeVolume === null) {
    return fullExit(reasonCode, position, stageState, {
      ...base,
      close_percent: 100,
      close_volume: position.volume,
      fallback_code: 'partial_volume_below_minimum',
    })
  }

  const stageResult = nextProtectionForStage(stageState, params, contract, position, stage)
  const action = {
    type: ACTION_TYPES.PARTIAL_EXIT,
    trigger_code: reasonCode,
    side_effect: true,
    ticket: position.ticket,
    symbol: position.symbol,
    close_percent: config.close_percent,
    close_volume: closeVolume,
    target_level: targetLevel,
    stage,
  }
  if (stageResult.protection) action.next_protection = stageResult.protection
  return success({
    action,
    next_stage_state: canonicalState(stageResult.state),
  })
}

function resolveNowMs(input) {
  const value = readFirst(input, ['now_ms', 'nowMs'])
  if (value === undefined) return Date.now()
  return readFinite(value, { min: 0 })
}

function stageWithPivotCross(state, since) {
  return { ...state, pivotCrossSinceMs: since }
}

/**
 * Evaluate one position snapshot.  The result contains exactly one action;
 * only actions whose `side_effect` is true may create a broker command.
 */
export function evaluatePositionGuard(input = {}) {
  if (!isRecord(input)) return failure('invalid_input')
  const paramsResult = validatePositionGuardParams(input.params)
  if (!paramsResult.ok) return paramsResult
  const positionResult = normalizePosition(input.position)
  if (!positionResult.ok) return positionResult
  const quoteResult = normalizeQuote(input.quote)
  if (!quoteResult.ok) return quoteResult
  const contractResult = normalizeContract(input.contract)
  if (!contractResult.ok) return contractResult
  const stageResult = normalizeStageState(input.stage_state ?? input.stageState)
  if (!stageResult.ok) return stageResult
  const nowMs = resolveNowMs(input)
  if (nowMs === null) return failure('invalid_evaluation_time')

  const d1 = input.d1 ?? input.previous_d1 ?? input.previousD1 ?? input.previous_closed_d1 ?? input.previousClosedD1
  if (!isRecord(d1)) return failure('invalid_d1')
  if (d1.ready === false || d1.data_ready === false) return failure('d1_not_ready')
  const previousOpenValue = readFirst(d1, [
    'previous_open_at',
    'previousOpenAt',
    'previous_d1_open_at',
    'previousD1OpenAt',
    'open_at',
    'openAt',
  ])
  const currentOpenValue = readFirst(d1, [
    'current_open_at',
    'currentOpenAt',
    'current_d1_open_at',
    'currentD1OpenAt',
  ])
  const previousOpen = normalizeTimestamp(previousOpenValue)
  const currentOpen = normalizeTimestamp(currentOpenValue)
  if ((previousOpenValue !== undefined && previousOpen === null)
    || (currentOpenValue !== undefined && currentOpen === null)) {
    return failure('invalid_d1_time')
  }
  if (previousOpen !== null && currentOpen !== null && previousOpen >= currentOpen) {
    return failure('invalid_d1_window')
  }
  const pivotResult = calculatePivotLevels({
    high: d1.high ?? d1.H,
    low: d1.low ?? d1.L,
    close: d1.close ?? d1.C,
    method: paramsResult.params.pivot_method,
  })
  if (!pivotResult.ok) return pivotResult

  const params = paramsResult.params
  const position = positionResult.position
  const quote = quoteResult.quote
  const contract = contractResult.contract
  const levels = pivotResult.levels
  const state = stageResult.state
  const evidence = baseEvidence(position, quote, levels)
  const closePrice = evidence.close_price
  const profitable = position.direction === 'buy' ? closePrice > position.open : closePrice < position.open
  let nextState = { ...state }
  let pivotCrossPending = false

  // 1. P-cross stop.  The filter is intentionally fixed on for this service.
  if (params.pivot_cross_stop.enabled) {
    const sameSide = position.direction === 'sell'
      ? position.open < levels.P
      : position.open > levels.P
    const crossed = sameSide && (position.direction === 'sell'
      ? closePrice >= levels.P + params.pivot_cross_stop.distance_price
      : closePrice <= levels.P - params.pivot_cross_stop.distance_price)
    if (crossed) {
      const since = state.pivotCrossSinceMs === null ? nowMs : state.pivotCrossSinceMs
      if (since > nowMs) return failure('invalid_stage_state_timestamp')
      nextState = stageWithPivotCross(state, since)
      const elapsed = nowMs - since
      const required = params.pivot_cross_stop.min_duration_seconds * 1000
      if (elapsed >= required) {
        return fullExit(REASON_CODES.PIVOT_CROSS_STOP, position, nextState, {
          ...evidence,
          threshold_price: position.direction === 'sell'
            ? levels.P + params.pivot_cross_stop.distance_price
            : levels.P - params.pivot_cross_stop.distance_price,
          elapsed_ms: elapsed,
        })
      }
      pivotCrossPending = true
    } else {
      nextState = stageWithPivotCross(state, null)
    }
  } else {
    nextState = stageWithPivotCross(state, null)
  }

  // 2. Key-level retrace stop.
  if (params.retrace_stop.enabled) {
    const keyLevel = findRetraceKeyLevel(levels, position.direction, position.open)
    const retraced = keyLevel !== null && (position.direction === 'buy'
      ? closePrice <= keyLevel - params.retrace_stop.distance_price
      : closePrice >= keyLevel + params.retrace_stop.distance_price)
    if (retraced) {
      return fullExit(REASON_CODES.RETRACE_STOP, position, nextState, {
        ...evidence,
        key_level: keyLevel,
        threshold_price: position.direction === 'buy'
          ? keyLevel - params.retrace_stop.distance_price
          : keyLevel + params.retrace_stop.distance_price,
      })
    }
  }

  // 3. Near-key break stop.
  if (params.break_stop.enabled) {
    const keyLevel = findBreakKeyLevel(
      levels,
      position.direction,
      position.open,
      params.break_stop.open_near_price,
    )
    const broken = keyLevel !== null && (position.direction === 'sell'
      ? closePrice >= keyLevel + params.break_stop.distance_price
      : closePrice <= keyLevel - params.break_stop.distance_price)
    if (broken) {
      return fullExit(REASON_CODES.BREAK_STOP, position, nextState, {
        ...evidence,
        key_level: keyLevel,
        threshold_price: position.direction === 'sell'
          ? keyLevel + params.break_stop.distance_price
          : keyLevel - params.break_stop.distance_price,
      })
    }
  }

  // 4. A previously accepted partial exit may need a separate protection edit.
  const breakEvenIntent = getBreakEvenIntent(nextState, params, contract, position)
  if (breakEvenIntent && !nextState.breakEvenDone) {
    const currentSl = position.sl
    const desired = nextState.breakEvenPending && nextState.pendingBreakEvenPrice !== null
      ? nextState.pendingBreakEvenPrice
      : breakEvenIntent.desired
    const alreadyStricter = currentSl !== null && (position.direction === 'buy'
      ? currentSl >= desired
      : currentSl <= desired)
    if (alreadyStricter) {
      const settledState = {
        ...nextState,
        breakEvenDone: true,
        breakEvenPending: false,
        pendingBreakEvenPrice: null,
        pendingBreakEvenSource: null,
      }
      return observe(REASON_CODES.PROTECTION_ALREADY_STRICTER, settledState, evidence, {
        protection_price: desired,
        side_effect: false,
      })
    }
    const minDistance = Math.max(contract.stopsLevelPoints, contract.freezeLevelPoints) * contract.point
    const validPrice = desired > 0 && (position.direction === 'buy'
      ? desired <= quote.bid - minDistance
      : desired >= quote.ask + minDistance)
    if (!validPrice) {
      return observe(
        pivotCrossPending ? REASON_CODES.PIVOT_CROSS_PENDING : REASON_CODES.PROTECTION_NOT_READY,
        nextState,
        evidence,
        { protection_price: desired, side_effect: false },
      )
    }
    const action = {
      type: ACTION_TYPES.MOVE_PROTECTION,
      trigger_code: REASON_CODES.BREAK_EVEN,
      side_effect: true,
      ticket: position.ticket,
      symbol: position.symbol,
      new_sl: desired,
      previous_sl: currentSl,
      source_stage: breakEvenIntent.source,
      ...evidence,
    }
    return success({ action, next_stage_state: canonicalState(nextState) })
  }

  // 5. P-point take profit.
  if (params.pivot_take_profit.enabled && !nextState.pivotTakeProfitDone && profitable) {
    const pivotIsTarget = position.direction === 'sell'
      ? position.open > levels.P
      : position.open < levels.P
    const reached = pivotIsTarget && (position.direction === 'sell'
      ? closePrice <= levels.P + params.pivot_take_profit.tolerance_price
      : closePrice >= levels.P - params.pivot_take_profit.tolerance_price)
    if (reached) {
      const firstTarget = findFirstTargetLevel(levels, position.direction, position.open)
      const pivotIsFirstTarget = firstTarget !== null
        && Math.abs(firstTarget - levels.P) <= contract.point * 0.5
      const result = takeProfitAction(
        REASON_CODES.PIVOT_TAKE_PROFIT,
        position,
        nextState,
        params,
        contract,
        'pivot_take_profit',
        levels.P,
        levels,
      )
      if (result.ok && pivotIsFirstTarget && result.next_stage_state) {
        const completedState = {
          ...nextState,
          pivotTakeProfitDone:true,
          firstTargetDone:true,
        }
        result.next_stage_state = canonicalState(completedState)
        if (result.action.type === ACTION_TYPES.PARTIAL_EXIT && params.first_target_take_profit.move_break_even) {
          const protectionState = nextProtectionForStage(
            completedState,
            params,
            contract,
            position,
            'pivot_take_profit',
          )
          result.next_stage_state = canonicalState(protectionState.state)
          if (result.action.next_protection) result.action.next_protection = protectionState.protection
        }
      }
      return result
    }
  }

  // 6. First profitable target.
  if (params.first_target_take_profit.enabled && !nextState.firstTargetDone && profitable) {
    const target = findFirstTargetLevel(levels, position.direction, position.open)
    const reached = target !== null && (position.direction === 'sell'
      ? closePrice <= target + params.first_target_take_profit.tolerance_price
      : closePrice >= target - params.first_target_take_profit.tolerance_price)
    if (reached) {
      return takeProfitAction(
        REASON_CODES.FIRST_TARGET_TAKE_PROFIT,
        position,
        nextState,
        params,
        contract,
        'first_target_take_profit',
        target,
        levels,
      )
    }
  }

  const reasonCode = pivotCrossPending ? REASON_CODES.PIVOT_CROSS_PENDING : REASON_CODES.NONE
  return observe(reasonCode, nextState, evidence, {
    profitable,
    first_target_level: findFirstTargetLevel(levels, position.direction, position.open),
  })
}

export const evaluate = evaluatePositionGuard
export const evaluatePosition = evaluatePositionGuard
export const calculatePivots = calculatePivotLevels
