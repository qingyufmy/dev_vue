import { canonical, exactKeys, hash, primaryKey, requireBackfill as check } from './v4-backfill-contract.mjs'

const supportedTransforms = new Set(['b2.exact', 'b2.legacy-id', 'b2.decimal'])
const integerType = /^(tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?( unsigned)?$/i

function textValue(cell) {
  if (cell.valueHex === null) return null
  check(cell.charset === null || ['utf8mb4', 'utf8mb3', 'utf8', 'ascii'].includes(cell.charset), 'identity_encoding_unsupported')
  const bytes = Buffer.from(cell.valueHex, 'hex'), value = bytes.toString('utf8')
  check(Buffer.from(value, 'utf8').equals(bytes), 'identity_encoding_invalid')
  check(cell.charset !== 'ascii' || /^[\x00-\x7f]*$/.test(value), 'identity_encoding_invalid')
  check(!['utf8mb3', 'utf8'].includes(cell.charset) || ![...value].some(c => c.codePointAt(0) > 0xffff), 'identity_encoding_invalid')
  return value
}

// Internal adapter for reviewed identity tables; callers must not log these values.
export function decodeIdentitySourceRow(tableContract, row) {
  const inspection = inspectIdentityValues(tableContract, row)
  return { inspection, values: Object.fromEntries(row.envelope.cells.map(cell => [cell.column, textValue(cell)])) }
}

// No defaults, coercive Number conversion, rounding or truncation are permitted.
export function representIdentityValue(value, type, nullable) {
  check(typeof type === 'string' && typeof nullable === 'boolean', 'identity_type_invalid')
  if (value === null) { check(nullable, 'identity_null_forbidden'); return null }
  check(typeof value === 'string' && value.length <= 2 * 1024 * 1024, 'identity_value_invalid')
  const integer = integerType.exec(type)
  if (integer) {
    check(/^(?:0|-?[1-9][0-9]*)$/.test(value) && value.length <= 21, 'identity_integer_invalid')
    const bits = BigInt({ tinyint: 8, smallint: 16, mediumint: 24, int: 32, bigint: 64 }[integer[1].toLowerCase()])
    const unsigned = Boolean(integer[2]), n = BigInt(value)
    check(n >= (unsigned ? 0n : -(2n ** (bits - 1n))) && n <= (unsigned ? 2n ** bits - 1n : 2n ** (bits - 1n) - 1n), 'identity_integer_overflow')
    return value
  }
  const decimal = /^decimal\((\d+),(\d+)\)$/i.exec(type)
  if (decimal) {
    const precision = Number(decimal[1]), scale = Number(decimal[2])
    check(precision >= 1 && precision <= 65 && scale <= 30 && scale <= precision, 'identity_type_invalid')
    check(value.length <= 70 && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value), 'identity_decimal_invalid')
    const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.')
    check((whole === '0' ? 0 : whole.length) <= precision - scale, 'identity_decimal_overflow')
    check(!/[1-9]/.test(fraction.slice(scale)), 'identity_decimal_rounding_forbidden')
    const padded = fraction.slice(0, scale).padEnd(scale, '0')
    const sign = negative && /[1-9]/.test(whole + padded) ? '-' : ''
    return sign + whole + (scale ? '.' + padded : '')
  }
  const text = /^(?:varchar|char)\((\d+)\)$/i.exec(type)
  if (text) {
    check(Buffer.from(value, 'utf8').toString('utf8') === value, 'identity_encoding_invalid')
    check([...value].length <= Number(text[1]), 'identity_text_too_long')
    return value
  }
  check(false, 'identity_type_unsupported')
}

export function inspectIdentityValues(tableContract, row) {
  // The caller must load the reviewed U1 artifact; its hash is provenance, not approval.
  check(Array.isArray(tableContract.fields) && tableContract.fields.length > 0 && tableContract.fields.length <= 128, 'identity_contract_invalid')
  check(new Set(tableContract.fields.map(f => f.sourceColumn)).size === tableContract.fields.length, 'identity_contract_invalid')
  exactKeys(row, ['pk', 'sourceHash', 'envelope']); primaryKey(row.pk)
  const envelope = row.envelope
  exactKeys(envelope, ['encoding', 'table', 'cells'])
  check(envelope.encoding === 'mysql-sql-value-hex-v1' && envelope.table === tableContract.sourceTable, 'identity_source_mismatch')
  check(Buffer.byteLength(canonical(envelope)) <= 2 * 1024 * 1024 && hash(envelope) === row.sourceHash, 'identity_source_hash_mismatch')
  check(Array.isArray(envelope.cells) && envelope.cells.length === tableContract.fields.length, 'identity_field_coverage_mismatch')
  const cells = new Map()
  for (const cell of envelope.cells) {
    exactKeys(cell, ['column', 'type', 'charset', 'valueHex'])
    const field = tableContract.fields.find(f => f.sourceColumn === cell.column)
    check(field && !cells.has(cell.column) && cell.type === field.sourceType, 'identity_field_coverage_mismatch')
    const charset = field.sourceCollation?.split('_')[0] ?? null
    check(cell.charset === charset, 'identity_source_charset_mismatch')
    check(cell.valueHex === null || (typeof cell.valueHex === 'string' && /^(?:[a-f0-9]{2})*$/.test(cell.valueHex)), 'identity_hex_invalid')
    cells.set(cell.column, cell)
  }
  check(tableContract.sourcePrimaryKey.length === row.pk.length, 'identity_pk_mismatch')
  tableContract.sourcePrimaryKey.forEach((name, i) => {
    const cell = cells.get(name)
    check(cell && cell.valueHex !== null, 'identity_pk_mismatch')
    const kind = integerType.test(cell.type) ? 'integer' : /^(?:var)?binary\(/i.test(cell.type) ? 'binary' : 'text'
    check(row.pk[i].type === kind && row.pk[i].value === (kind === 'binary' ? cell.valueHex : textValue(cell)), 'identity_pk_mismatch')
  })
  const fields = tableContract.fields.map(field => {
    const base = { sourceColumn: field.sourceColumn, target: field.target, blockers: [...field.blockers] }
    if (!supportedTransforms.has(field.transformId) || field.timeKind !== 'not_time' || !field.review?.targetDeclaration || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(field.target)) {
      return { ...base, status: 'deferred', code: 'identity_specialized_transform_required' }
    }
    try {
      const value = textValue(cells.get(field.sourceColumn))
      representIdentityValue(value, field.sourceType, field.sourceNullable)
      const target = field.review.sourceToPlan
      const candidate = representIdentityValue(value, target.declaredType, target.declaredNullable)
      return { ...base, status: 'candidate', value: candidate, targetType: target.declaredType, targetNullable: target.declaredNullable }
    } catch (error) {
      return { ...base, status: 'blocked', code: /^identity_[a-z_]+$/.test(error.code ?? '') ? error.code : 'identity_value_invalid' }
    }
  })
  return { contractHash: hash(tableContract), sourceHash: row.sourceHash, pk: structuredClone(row.pk), fields, readyForBackfill: false }
}

// Inputs must be independently read logical values, not the writer's acknowledgements.
export function compareIdentityCandidates(inspection, actual) {
  check(actual && Object.getPrototypeOf(actual) === Object.prototype, 'identity_actual_invalid')
  const expected = inspection.fields.filter(f => f.status === 'candidate')
  check(new Set(expected.map(f => f.target)).size === expected.length, 'identity_target_collision')
  const differences = []
  for (const field of expected) {
    if (!Object.hasOwn(actual, field.target)) { differences.push({ target: field.target, code: 'missing' }); continue }
    try {
      const value = representIdentityValue(actual[field.target], field.targetType, field.targetNullable)
      if (value !== field.value) differences.push({ target: field.target, code: 'value_mismatch' })
    } catch { differences.push({ target: field.target, code: 'invalid_value' }) }
  }
  for (const target of Object.keys(actual)) if (!expected.some(f => f.target === target)) differences.push({ target, code: 'unexpected' })
  return { compared: expected.length, deferredOrBlocked: inspection.fields.length - expected.length,
    candidateValuesMatch: expected.length > 0 && differences.length === 0, differences,
    fullRowReconciled: false, readyForBackfill: false }
}
