// Deterministic semantic guardrails for strategy-memory compression.
//
// The durable memory remains human-readable Markdown.  This module only
// derives a stable source manifest and validates the provider's structured
// response before the existing library CAS/apply path is reached.  It is
// intentionally side-effect free so the provider callback and the final
// pre-apply check use exactly the same validator.

import crypto from 'node:crypto'

const OUTPUT_KEYS = ['content_text', 'coverage_map', 'unresolved_conflicts', 'removed_redundancies']
const COVERAGE_KEYS = ['source_block_id', 'result_section', 'disposition']
const DISPOSITIONS = new Set(['preserved', 'merged_duplicate'])
const COVERAGE_ANCHOR_FIELDS = ['numbers', 'numeric_expressions', 'percentages', 'prices',
  'timeframes', 'directions', 'symbols', 'markers']

const MARKER_GROUPS = Object.freeze({
  risk: ['风险', '止损', '止盈', '仓位', '风控', '警告', '边界'],
  negation: ['不得', '禁止', '不能', '不应', '不可', '严禁', '不要'],
  exception: ['仅', '除非', '例外', '否则', '前提', '条件', '适用'],
  conflict: ['反例', '冲突', '不确定', '未知', '待确认', '矛盾'],
})

const SYMBOL_STOPWORDS = new Set([
  'AURUM', 'MARKDOWN', 'CONTENT', 'CURRENT', 'MEMORY', 'SYSTEM', 'OUTPUT', 'SOURCE',
  'TARGET', 'SECTION', 'PRESERVED', 'MERGED', 'DUPLICATE', 'RISK', 'ENTRY', 'EXIT',
  'STOPLOSS', 'TAKEPROFIT', 'JSON', 'HTTP', 'HTTPS', 'USD', 'USDT', 'EUR', 'RMB',
])

const HEX_OR_ID_PATTERN = /(?:migration|migrate|review|period|case|source|update|revision|job|task|id)[_:/#-]?[a-f0-9]{4,}/giu
const FORBIDDEN_RUNTIME_METADATA_PATTERN = /(?:["'`]?(?:applicable_when|avoid_when|applicability|migration_id|migration_table|source_period_review_version_id|period_review_case_id|pending_update_id)["'`]?\s*:|(?:迁移(?:表|来源|ID)|migration(?:\s+(?:table|source|id))?)\s*[:：#]?\s*[A-Za-z0-9_-]*\d+)/iu

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function semanticError(kind, detail = '') {
  const code = `strategy_memory_compression_${kind}`
  const error = new Error(detail ? `${code}:${detail}` : code)
  error.code = code
  error.validationCode = kind
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Normalize only transport whitespace/control noise.  We do not trim the
 * provider's final body here: the library hashes the exact Markdown body and
 * must retain its existing noop/CAS behaviour.
 */
export function normalizeStrategyMemorySemanticText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
}

function normalizeBlockText(value) {
  const text = normalizeStrategyMemorySemanticText(value)
  const lines = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim())
  const compact = []
  let blank = false
  for (const line of lines) {
    if (!line) {
      if (!blank && compact.length) compact.push('')
      blank = true
    } else {
      compact.push(line)
      blank = false
    }
  }
  while (compact[0] === '') compact.shift()
  while (compact[compact.length - 1] === '') compact.pop()
  return compact.join('\n')
}

function headingLine(line) {
  return /^#{1,6}\s+/u.test(line)
}

function listItemLine(line) {
  return /^\s*(?:\d+[.)、]|[-+*•])\s+/u.test(line)
}

function removeStructuralNumbering(line, firstLine) {
  let value = line
  if (firstLine && headingLine(value)) {
    value = value.replace(/^#{1,6}\s+/u, '')
    // Numbered titles ("## 1. 风险") are presentation structure, not a
    // business number.  A number later in the title remains an anchor.
    value = value.replace(/^(?:第\s*)?\d+(?:[.)、:：-])\s*/u, '')
  }
  // Ordered-list markers are likewise presentation structure.  The rest of a
  // list item is still scanned, so "1. 风险为 2%" retains the 2% anchor.
  return value.replace(/^\s*(?:\d+[.)、]|[-+*•])\s+/u, '')
}

function anchorText(value) {
  const lines = normalizeStrategyMemorySemanticText(value).split('\n')
  return lines.map((line, index) => removeStructuralNumbering(line, index === 0)).join('\n')
}

function uniqueSorted(values) {
  return [...new Set(values.filter(value => value !== ''))].sort((left, right) =>
    String(left).localeCompare(String(right), 'en', { numeric: true }))
}

function canonicalNumber(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/，/gu, ',')
}

function extractNumericExpressions(text) {
  // Internal IDs are metadata, not trading rules.  They should never be
  // copied into the body and are not useful semantic anchors.
  const value = text.replace(HEX_OR_ID_PATTERN, '')
  const expressions = []
  const percentages = []
  const prices = []
  const pricePattern = /(?:[$€£¥]|\b(?:USD|USDT|EUR|RMB)\b|人民币)\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*%|\b)?/giu
  for (const match of value.matchAll(pricePattern)) {
    const token = canonicalNumber(match[0])
    prices.push(token)
    expressions.push(token)
  }
  const percentPattern = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*%/gu
  for (const match of value.matchAll(percentPattern)) {
    const token = canonicalNumber(match[0])
    percentages.push(token)
    expressions.push(token)
  }
  const clockPattern = /(?<![A-Za-z0-9_])\d{1,2}:\d{2}(?![A-Za-z0-9_])/gu
  for (const match of value.matchAll(clockPattern)) expressions.push(canonicalNumber(match[0]))
  const numberPattern = /(?<![A-Za-z0-9_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![A-Za-z0-9_])/gu
  for (const match of value.matchAll(numberPattern)) {
    const token = canonicalNumber(match[0])
    const prefix = value.slice(Math.max(0, Number(match.index) - 6), Number(match.index))
    if (/[$€£¥]\s*$/u.test(prefix) || /(?:USD|USDT|EUR|RMB)\s*$/iu.test(prefix)) continue
    // The complete percentage/price expression is more useful than its
    // constituent number.  Keep ordinary numbers separately.
    if (!expressions.includes(token) && !percentages.some(item => item.replace(/%$/u, '') === token)) {
      expressions.push(token)
    }
  }
  return {
    numbers:uniqueSorted(expressions),
    numeric_expressions:uniqueSorted(expressions),
    percentages:uniqueSorted(percentages),
    prices:uniqueSorted(prices),
  }
}

function extractTimeframes(text) {
  return uniqueSorted([...text.matchAll(/\b(?:M1|M5|M15|M30|H1|H4|D1|W1|MN1)\b/giu)]
    .map(match => String(match[0]).toUpperCase()))
}

function extractDirections(text) {
  const directions = []
  for (const match of text.matchAll(/\b(?:buy|sell|long|short)\b/giu)) {
    directions.push(String(match[0]).toLowerCase())
  }
  // Avoid treating every occurrence of the Chinese characters 多/空 in a
  // normal sentence as a trading direction.  Standalone terms and the common
  // trading compounds are retained.
  const chinesePatterns = [
    /(?:多头|空头|多单|空单|做多|做空|看多|看空)/gu,
    /(?<![\u3400-\u9fff])多(?![\u3400-\u9fff])/gu,
    /(?<![\u3400-\u9fff])空(?![\u3400-\u9fff])/gu,
  ]
  for (const pattern of chinesePatterns) {
    for (const match of text.matchAll(pattern)) directions.push(match[0].includes('空') ? '空' : '多')
  }
  return uniqueSorted(directions)
}

function extractSymbols(text) {
  const symbols = []
  const pattern = /\b(?:[A-Z]{6,12}|[A-Z]{2,5}\d{1,4})\b/g
  for (const match of text.matchAll(pattern)) {
    const token = String(match[0]).toUpperCase()
    if (!SYMBOL_STOPWORDS.has(token) && !/^M(?:1|5|15|30)$|^H(?:1|4)$|^D1$|^W1$|^MN1$/u.test(token)) {
      symbols.push(token)
    }
  }
  return uniqueSorted(symbols)
}

function extractMarkers(text) {
  const result = {}
  for (const [group, terms] of Object.entries(MARKER_GROUPS)) {
    result[group] = uniqueSorted(terms.filter(term => text.includes(term)))
  }
  result.all = uniqueSorted(Object.values(result).flat())
  return result
}

/** Extract deterministic, category-preserving anchors from one Markdown block. */
export function extractStrategyMemorySemanticAnchors(value) {
  const text = anchorText(value)
  const numeric = extractNumericExpressions(text)
  const markers = extractMarkers(text)
  return {
    numbers:numeric.numbers,
    numeric_expressions:numeric.numeric_expressions,
    percentages:numeric.percentages,
    prices:numeric.prices,
    timeframes:extractTimeframes(text),
    directions:extractDirections(text),
    symbols:extractSymbols(text),
    markers:markers.all,
    marker_groups:{
      risk:markers.risk,
      negation:markers.negation,
      exception:markers.exception,
      conflict:markers.conflict,
    },
  }
}

export const extractStrategyMemoryAnchors = extractStrategyMemorySemanticAnchors

function splitMarkdownBlocks(value) {
  const normalized = normalizeBlockText(value)
  if (!normalized) return []
  const lines = normalized.split('\n')
  const blocks = []
  let current = []
  let hasHeading = false
  const flush = () => {
    const text = normalizeBlockText(current.join('\n'))
    if (text) blocks.push(text)
    current = []
    hasHeading = false
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (headingLine(line)) {
      if (current.length) flush()
      current.push(line)
      hasHeading = true
      continue
    }
    if (!line && current.length && !hasHeading) {
      // A blank line between list items is still one logical Markdown list;
      // keep it together while preserving blank-line paragraph boundaries.
      const currentHasList = current.some(listItemLine)
      const nextLine = lines[index + 1] || ''
      if (currentHasList && listItemLine(nextLine)) {
        current.push(line)
        continue
      }
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}

// Keep the Markdown block boundaries in one place for compression, preview
// rendering, and conflict-location validation.  The implementation remains
// private so callers cannot accidentally mutate the manifest internals; this
// public wrapper returns a fresh array of normalized block strings.
export function splitStrategyMemoryMarkdownBlocks(value) {
  return splitMarkdownBlocks(value).slice()
}

export function normalizeStrategyMemoryMarkdownBlock(value) {
  return normalizeBlockText(value)
}

function sourceEntries(input = {}) {
  if (typeof input === 'string') input = { content_text:input }
  if (Array.isArray(input.sources)) {
    return input.sources.map((source, index) => ({
      namespace:String(source?.namespace || source?.source || `source:${index + 1}`),
      text:source?.text ?? source?.content_text ?? source?.content ?? '',
    }))
  }
  const content = input.content_text ?? input.contentText ?? input.currentText ?? input.current_text
    ?? input.text ?? input.content ?? ''
  const entries = [{ namespace:String(input.namespace || 'current_library'), text:content }]
  if (input.includePendingUpdates !== false && Array.isArray(input.pendingUpdates)) {
    for (const [index, update] of input.pendingUpdates.entries()) {
      entries.push({ namespace:`pending_update:${Number(update?.id) || index + 1}`,
        text:update?.content_text ?? update?.content ?? '' })
    }
  }
  return entries
}

function mergeAnchors(blocks) {
  const fields = ['numbers', 'numeric_expressions', 'percentages', 'prices', 'timeframes', 'directions', 'symbols', 'markers']
  const result = Object.fromEntries(fields.map(field => [field, []]))
  const groups = { risk:[], negation:[], exception:[], conflict:[] }
  for (const block of blocks) {
    for (const field of fields) result[field].push(...(block.anchors?.[field] || []))
    for (const group of Object.keys(groups)) groups[group].push(...(block.anchors?.marker_groups?.[group] || []))
  }
  for (const field of fields) result[field] = uniqueSorted(result[field])
  result.marker_groups = Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, uniqueSorted(values)]))
  return result
}

function stableAnchorJson(anchors) {
  return JSON.stringify({
    numbers:anchors.numbers || [], numeric_expressions:anchors.numeric_expressions || [],
    percentages:anchors.percentages || [], prices:anchors.prices || [],
    timeframes:anchors.timeframes || [], directions:anchors.directions || [], symbols:anchors.symbols || [],
    markers:anchors.markers || [], marker_groups:anchors.marker_groups || {},
  })
}

/**
 * Build a stable source manifest.  IDs include a namespace and duplicate
 * occurrence so identical current/pending blocks cannot collide while their
 * content hash remains the plain SHA-256 of normalized block text.
 */
export function buildStrategyMemorySourceManifest(input = {}) {
  const blocks = []
  const occurrences = new Map()
  for (const source of sourceEntries(input)) {
    for (const text of splitMarkdownBlocks(source.text)) {
      const hash = sha256(text)
      const occurrenceKey = `${source.namespace}\u0000${hash}`
      const occurrence = (occurrences.get(occurrenceKey) || 0) + 1
      occurrences.set(occurrenceKey, occurrence)
      const id = sha256(`${source.namespace}\u0000${occurrence}\u0000${text}`)
      const anchors = extractStrategyMemorySemanticAnchors(text)
      blocks.push({ id, source_block_id:id, hash, text, anchors,
        anchor_fingerprint:sha256(stableAnchorJson(anchors)) })
    }
  }
  const anchors = mergeAnchors(blocks)
  const sourceText = blocks.map(block => block.text).join('\n\n')
  const manifest = {
    schema_version:1,
    source_text_hash:sha256(sourceText),
    source_block_ids:blocks.map(block => block.id),
    source_blocks:blocks,
    block_count:blocks.length,
    anchors,
    anchor_fingerprint:sha256(stableAnchorJson(anchors)),
  }
  // `blocks` is retained as a friendly non-enumerable alias.  Keeping it out
  // of JSON prompts avoids sending every source block twice to the provider.
  Object.defineProperty(manifest, 'blocks', { value:blocks, enumerable:false })
  return manifest
}

export const buildStrategyMemoryCompressionManifest = buildStrategyMemorySourceManifest
export const buildStrategyMemorySemanticManifest = buildStrategyMemorySourceManifest

function manifestBlocks(manifest) {
  const blocks = Array.isArray(manifest?.source_blocks) ? manifest.source_blocks
    : (Array.isArray(manifest?.blocks) ? manifest.blocks : [])
  return blocks.filter(block => isPlainObject(block)
    && typeof (block.id ?? block.source_block_id) === 'string')
    .map(block => block.id ? block : { ...block, id:block.source_block_id })
}

function normalizeForContains(value) {
  return normalizeBlockText(value).replace(/[\s\u3000]+/gu, ' ').trim()
}

function duplicateEligibleIds(blocks) {
  const byHash = new Map()
  for (const block of blocks) {
    const normalized = normalizeBlockText(block.text)
    const lines = normalized.split('\n')
    const body = headingLine(lines[0]) ? normalizeBlockText(lines.slice(1).join('\n')) : normalized
    // Exact text hashes remain the primary identity.  A heading-only rename
    // with identical body and anchors is also deterministic equivalent
    // repetition; a changed body or anchor is never eligible for merging.
    const keys = [`hash:${String(block.hash || sha256(normalized))}`]
    if (body) keys.push(`body:${body}\u0000${stableAnchorJson(block.anchors || {})}`)
    for (const key of keys) {
      const group = byHash.get(key) || []
      group.push(block.id)
      byHash.set(key, group)
    }
  }
  return new Set([...byHash.values()].filter(group => group.length > 1).flat())
}

function outputShape(value) {
  if (!isPlainObject(value)) throw semanticError('output_invalid', 'response must be an object')
  const keys = Object.keys(value).sort()
  const expected = [...OUTPUT_KEYS].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw semanticError('output_invalid', 'response keys must match the compression schema')
  }
  if (typeof value.content_text !== 'string') throw semanticError('output_invalid', 'content_text must be a string')
  if (!Array.isArray(value.coverage_map) || !Array.isArray(value.unresolved_conflicts)
      || !Array.isArray(value.removed_redundancies)) {
    throw semanticError('output_invalid', 'response field types are invalid')
  }
  if (value.unresolved_conflicts.some(item => typeof item !== 'string')
      || value.removed_redundancies.some(item => typeof item !== 'string')) {
    throw semanticError('output_invalid', 'diagnostic arrays must contain strings')
  }
}

function validateCoverage(value, blocks, resultText) {
  const known = new Set(blocks.map(block => block.id))
  const duplicateIds = duplicateEligibleIds(blocks)
  const seen = new Set()
  const rows = []
  for (const entry of value.coverage_map) {
    if (!isPlainObject(entry)) throw semanticError('coverage_invalid', 'coverage rows must be objects')
    const keys = Object.keys(entry).sort()
    if (keys.length !== COVERAGE_KEYS.length || keys.some((key, index) => key !== [...COVERAGE_KEYS].sort()[index])) {
      throw semanticError('coverage_invalid', 'coverage row keys are invalid')
    }
    const id = String(entry.source_block_id || '')
    if (!known.has(id)) throw semanticError('coverage_invalid', `unknown source block: ${id}`)
    if (seen.has(id)) throw semanticError('coverage_invalid', `duplicate source block: ${id}`)
    seen.add(id)
    if (typeof entry.result_section !== 'string' || !entry.result_section.trim()
        || entry.result_section.length > 512) {
      throw semanticError('coverage_invalid', `invalid result section: ${id}`)
    }
    if (!DISPOSITIONS.has(entry.disposition)) throw semanticError('coverage_invalid', `invalid disposition: ${id}`)
    if (entry.disposition === 'merged_duplicate' && !duplicateIds.has(id)) {
      throw semanticError('coverage_invalid', `non-duplicate block marked merged_duplicate: ${id}`)
    }
    if (!normalizeForContains(resultText).includes(normalizeForContains(entry.result_section))) {
      throw semanticError('coverage_invalid', `result section not found: ${id}`)
    }
    rows.push({ entry, block:blocks.find(block => block.id === id) })
  }
  if (seen.size !== known.size || [...known].some(id => !seen.has(id))) {
    throw semanticError('coverage_invalid', 'source blocks must be covered exactly once')
  }
  validateCoverageAnchorAssociations(rows)
}

function anchorValues(anchors, field) {
  return uniqueSorted(anchors?.[field] || [])
}

function assertAnchorEquality(expected, actual, field, sectionKey) {
  const expectedValues = anchorValues(expected, field)
  const actualValues = anchorValues(actual, field)
  if (expectedValues.length !== actualValues.length
      || expectedValues.some((value, index) => value !== actualValues[index])) {
    throw semanticError('semantic_anchor_mismatch', `coverage:${sectionKey}:${field}`)
  }
}

/**
 * A global anchor set cannot prove that a model kept each rule's association
 * (for example M15/1% must not be swapped with H1/2%).  Compare every exact
 * result-section group with the union of the source blocks mapped to it.  A
 * group containing multiple explicit source rows is the only place where the
 * section may legitimately contain the union of their anchors.
 */
function validateCoverageAnchorAssociations(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = normalizeForContains(row.entry.result_section)
    const group = groups.get(key) || []
    group.push(row)
    groups.set(key, group)
  }
  for (const [sectionKey, group] of groups.entries()) {
    const sourceAnchors = mergeAnchors(group.map(row => row.block))
    const resultAnchors = extractStrategyMemorySemanticAnchors(group[0].entry.result_section)
    for (const field of COVERAGE_ANCHOR_FIELDS) {
      assertAnchorEquality(sourceAnchors, resultAnchors, field, sectionKey)
    }
  }
}

function asAnchorSets(manifest) {
  const blocks = manifestBlocks(manifest)
  return mergeAnchors(blocks)
}

function assertSubset(required, actual, category) {
  const actualSet = new Set(actual || [])
  const missing = (required || []).filter(item => !actualSet.has(item))
  if (missing.length) throw semanticError('semantic_anchor_mismatch', `${category}:${missing.join(',')}`)
}

function validateAnchors(value, sourceManifest) {
  const source = asAnchorSets(sourceManifest)
  const resultManifest = buildStrategyMemorySourceManifest({ content_text:value.content_text, includePendingUpdates:false })
  const result = resultManifest.anchors
  for (const category of ['numbers', 'numeric_expressions', 'percentages', 'prices', 'timeframes', 'directions', 'symbols']) {
    assertSubset(source[category], result[category], category)
    const sourceSet = new Set(source[category] || [])
    const added = (result[category] || []).filter(item => !sourceSet.has(item))
    if (added.length) throw semanticError('semantic_anchor_mismatch', `new_${category}:${added.join(',')}`)
  }
  // Markers are required to survive, but an added explanatory marker does not
  // create a numeric/timeframe/symbol/direction business fact by itself.
  assertSubset(source.markers, result.markers, 'markers')
  for (const category of ['risk', 'negation', 'exception', 'conflict']) {
    assertSubset(source.marker_groups?.[category], result.marker_groups?.[category], `${category}_markers`)
  }
}

/**
 * Validate a provider response using the complete deterministic contract.
 * The returned `output` is the same shape that can safely be passed to the
 * apply path; diagnostics are intentionally kept outside that shape.
 */
export function validateStrategyMemoryCompressionOutput(input = {}, manifestArg = null, targetArg = null) {
  const options = isPlainObject(input) && (
    Object.prototype.hasOwnProperty.call(input, 'output')
      || Object.prototype.hasOwnProperty.call(input, 'sourceManifest')
      || Object.prototype.hasOwnProperty.call(input, 'targetChars')
  ) ? input : { output:input, sourceManifest:manifestArg, targetChars:targetArg }
  const { output, sourceManifest, targetChars } = options
  outputShape(output)
  const blocks = manifestBlocks(sourceManifest)
  if (!sourceManifest || !Array.isArray(sourceManifest.source_blocks) && !Array.isArray(sourceManifest.blocks)) {
    throw semanticError('output_invalid', 'source manifest is missing')
  }
  const content = normalizeStrategyMemorySemanticText(output.content_text)
  const limit = Math.max(1, Math.trunc(Number(targetChars) || 0))
  if (Array.from(content).length > limit) throw semanticError('output_exceeds_target')
  if (FORBIDDEN_RUNTIME_METADATA_PATTERN.test(content)) {
    throw semanticError('semantic_anchor_mismatch', 'forbidden_runtime_metadata')
  }
  validateCoverage(output, blocks, content)
  validateAnchors({ ...output, content_text:content }, sourceManifest)
  return {
    ok:true,
    output:{ content_text:content, coverage_map:output.coverage_map,
      unresolved_conflicts:output.unresolved_conflicts, removed_redundancies:output.removed_redundancies },
    source_block_ids:blocks.map(block => block.id),
    result_anchors:buildStrategyMemorySourceManifest({ content_text:content, includePendingUpdates:false }).anchors,
  }
}

export const validateStrategyMemoryCompressionResponse = validateStrategyMemoryCompressionOutput
export const validateStrategyMemoryCompression = validateStrategyMemoryCompressionOutput
export const validateStrategyMemoryCompressionResult = validateStrategyMemoryCompressionOutput

export function semanticManifestHash(manifest) {
  return sha256(JSON.stringify({
    source_text_hash:manifest?.source_text_hash || '',
    source_block_ids:(manifest?.source_block_ids || manifestBlocks(manifest).map(block => block.id)),
    anchor_fingerprint:manifest?.anchor_fingerprint || sha256(stableAnchorJson(asAnchorSets(manifest))),
  }))
}

export const strategyMemorySemanticError = semanticError
