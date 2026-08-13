// Deterministic cleanup for strategy-memory bodies written by the pre-unified
// memory system.  Applicability belongs to review/source metadata; it must not
// be copied into the editable Markdown library or model input.

const LEGACY_CONDITION_KEYS = Object.freeze([
  'applicability', 'applicable_when', 'avoid_when', '适用条件', '规避条件',
])

const LEGACY_CONDITION_KEY_PATTERN = new RegExp(
  `^(?:${LEGACY_CONDITION_KEYS.map(key => key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})$`, 'iu')
const LEGACY_CONDITION_KEY_SCAN_PATTERN = new RegExp(
  `(?:${LEGACY_CONDITION_KEYS.map(key => key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})`, 'giu')

const CONDITION_VALUE_FIELDS = new Set([
  'symbols', 'symbol', 'timeframes', 'timeframe', 'directions', 'direction',
  'market_regimes', 'market_regime', 'context_tuples', 'universal', 'conditions',
  'regimes', 'sessions', 'entry_modes', 'avoid', 'exclude',
])

const LEGACY_MEMORY_CATEGORIES = new Set([
  'general', 'market_regime', 'entry_setup', 'chan_structure', 'risk_execution',
])

const FIXED_LEGACY_MEMORY_HEADINGS = new Set([
  '# 策略记忆库',
  '## 已确认复盘经验', '## 稳定经验', '## 历史压缩结论', '## 平台已发布经验',
  '## 日复盘确认经验', '## 月复盘确认经验',
])

const LEGACY_IMPORT_QUOTE = '> 以下内容由旧记忆系统中仍有效且归属明确的记录一次性导入。'

function isLegacyReviewHeading(line) {
  const value = String(line || '').trim()
  if (FIXED_LEGACY_MEMORY_HEADINGS.has(value)) return true
  return /^##\s+(?:\d{4}[-年]\d{1,2}(?:[-月]\d{1,2}日?)?\s*)?(?:日|月)复盘确认经验$/u.test(value)
}

function isLegacySourceLine(line) {
  const value = String(line || '').trim().replace(/^[-+*•]\s+/u, '')
  const match = value.match(/^(迁移来源|来源)\s*[：:]\s*(.+)$/u)
  if (!match) return false
  const source = match[2].trim()
  if (/^\s*(?:personal_item|personal_long|personal_summary|platform_item)\s*#\d+\s*$/iu.test(source)) return true
  return /^(?:(?:outcome|period_review_case|period_review_version):\d+)(?:\s*[、,，]\s*(?:(?:outcome|period_review_case|period_review_version):\d+))*\s*$/iu.test(source)
}

function isLegacyConfidenceLine(line) {
  const value = String(line || '').trim().replace(/^[-+*•]\s+/u, '')
  return /^置信度\s*[：:]\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*$/u.test(value)
}

function removeLegacyCategoryPrefix(line) {
  const value = String(line)
  const match = value.match(/^(\s*[-+*•]\s+)(?:\[([a-z_]+)\])\s*/iu)
  if (!match || !LEGACY_MEMORY_CATEGORIES.has(String(match[2]).toLowerCase())) {
    return { text:value, removed:0 }
  }
  return { text:`${match[1]}${value.slice(match[0].length)}`, removed:1 }
}

/**
 * Remove only the exact wrappers emitted by the former review/import writer.
 * This intentionally leaves arbitrary user headings, [general] prose in the
 * middle of a sentence, and natural-language 来源/置信度 text untouched.
 */
export function sanitizeStrategyMemoryReviewPackaging(value) {
  const normalized = String(value ?? '').replace(/\r\n?/g, '\n')
  const kept = []
  let removed = 0
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === LEGACY_IMPORT_QUOTE || isLegacyReviewHeading(line)
        || isLegacySourceLine(line) || isLegacyConfidenceLine(line)) {
      removed += 1
      continue
    }
    const category = removeLegacyCategoryPrefix(line)
    removed += category.removed
    kept.push(category.text)
  }
  const content = removed ? kept.join('\n').replace(/\n{3,}/g, '\n\n') : normalized
  return { content, changed:removed > 0, removed }
}

function hasLegacyConditionKey(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasLegacyConditionKey)
  return Object.entries(value).some(([key, nested]) =>
    LEGACY_CONDITION_KEY_PATTERN.test(String(key)) || hasLegacyConditionKey(nested))
}

function matchingBracketEnd(text, start) {
  const opening = text[start]
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : ')'
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === opening) depth += 1
    else if (char === closing) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function parsedLegacyObject(text, start) {
  const end = matchingBracketEnd(text, start)
  if (end <= start || text[start] !== '{') return null
  const raw = text.slice(start, end)
  try {
    const parsed = JSON.parse(raw)
    return hasLegacyConditionKey(parsed) ? { end, raw, parsed } : null
  } catch {
    return null
  }
}

function stripLegacyConditionValues(value) {
  if (Array.isArray(value)) {
    let changed = false
    const next = []
    for (const item of value) {
      const stripped = stripLegacyConditionValues(item)
      changed = changed || stripped.changed
      next.push(stripped.value)
    }
    return { value:next, changed }
  }
  if (!value || typeof value !== 'object') return { value, changed:false }
  let changed = false
  const next = {}
  for (const [key, nested] of Object.entries(value)) {
    if (LEGACY_CONDITION_KEY_PATTERN.test(String(key))) {
      changed = true
      continue
    }
    const stripped = stripLegacyConditionValues(nested)
    changed = changed || stripped.changed
    next[key] = stripped.value
  }
  return { value:next, changed }
}

function serializedNonEmptyValue(value) {
  if (value == null) return ''
  if (Array.isArray(value) && value.length === 0) return ''
  if (typeof value === 'object' && Object.keys(value).length === 0) return ''
  return JSON.stringify(value)
}

function legacyHeading(line) {
  const value = String(line || '').trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^[-+*•]\s+/u, '')
    .replace(/^[*_`~]+|[*_`~]+$/gu, '')
    .trim()
  return LEGACY_CONDITION_KEYS.some(key => value.toLowerCase() === key.toLowerCase())
}

function structuredConditionValueLine(line) {
  const value = String(line || '').trim().replace(/^[-+*•]\s+/u, '')
  const match = value.match(/^["'`*_~]*([A-Za-z_][A-Za-z0-9_]*|[\u3400-\u9fff]+)["'`*_~]*\s*[:：]/u)
  if (!match) return /^[[{][\s\S]*[\]}],?$/u.test(value)
  return CONDITION_VALUE_FIELDS.has(String(match[1]).toLowerCase())
}

function lineIsLegacyCondition(line) {
  const value = String(line || '').trim()
  if (!value) return false
  if (/^(?:[-+*•]\s+|>\s*)?(?:["'`*_~]*)(?:applicability|applicable_when|avoid_when|适用条件|规避条件)(?:["'`*_~]*)\s*[:：=]/iu.test(value)) {
    return true
  }
  return false
}

function removeInlineConditionSegments(line) {
  let result = String(line)
  let removed = 0
  let match
  LEGACY_CONDITION_KEY_SCAN_PATTERN.lastIndex = 0
  while ((match = LEGACY_CONDITION_KEY_SCAN_PATTERN.exec(result))) {
    let start = match.index
    while (start > 0 && /["'`*_~]/u.test(result[start - 1])) start -= 1
    // A key is structured only when it is followed by a field separator. This
    // keeps ordinary prose such as “适用条件明确后再观察” intact.
    let cursor = match.index + match[0].length
    while (/^["'`*_~\]）)\s]/u.test(result[cursor] || '')) cursor += 1
    if (![':', '：', '='].includes(result[cursor])) continue
    cursor += 1
    while (/^[\s]/u.test(result[cursor] || '')) cursor += 1
    let end = cursor
    if (['{', '['].includes(result[cursor])) {
      const bracketEnd = matchingBracketEnd(result, cursor)
      end = bracketEnd > cursor ? bracketEnd : result.length
    } else {
      const delimiter = result.slice(cursor).search(/[;；,，]|(?=[)）\]}])/u)
      end = delimiter < 0 ? result.length : cursor + delimiter
    }
    if (/^[;；,，]/u.test(result[end] || '')) end += 1
    result = `${result.slice(0, start)}${result.slice(end)}`
    removed += 1
    LEGACY_CONDITION_KEY_SCAN_PATTERN.lastIndex = Math.max(0, start - 1)
  }
  return { text:result, removed }
}

function removeInlineConditionObjects(line) {
  let result = String(line)
  let removed = 0
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] !== '{') continue
    const parsed = parsedLegacyObject(result, index)
    if (!parsed) continue
    const stripped = stripLegacyConditionValues(parsed.parsed)
    const replacement = serializedNonEmptyValue(stripped.value)
    result = `${result.slice(0, index)}${replacement}${result.slice(parsed.end)}`
    removed += 1
    index = Math.max(-1, index - 1)
  }
  return { text:result, removed }
}

function removeLegacyFence(lines, index) {
  const opening = String(lines[index] || '').trim()
  if (!/^```(?:json|javascript)?\s*$/iu.test(opening)) return null
  const end = lines.findIndex((line, offset) => offset > index && String(line || '').trim() === '```')
  if (end < 0) return null
  const body = lines.slice(index + 1, end).join('\n').trim()
  try {
    const parsed = JSON.parse(body)
    if (!hasLegacyConditionKey(parsed)) return null
    const stripped = stripLegacyConditionValues(parsed)
    const replacement = serializedNonEmptyValue(stripped.value)
    return { end, removed:1, replacement:replacement ? `${opening}\n${replacement}\n\`\`\`` : '' }
  } catch {
    return null
  }
}

/**
 * Remove only recognizable structured applicability metadata from an old
 * library body. Natural-language sentences are retained. The returned text is
 * suitable for a new revision and can be safely passed through the existing
 * no-condition validator.
 */
export function sanitizeLegacyStrategyMemoryContent(value, { reviewPackaging = false } = {}) {
  const normalized = String(value ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const kept = []
  let removed = 0
  let inLegacyHeading = false
  for (let index = 0; index < lines.length; index += 1) {
    const fence = removeLegacyFence(lines, index)
    if (fence) {
      removed += fence.removed
      if (fence.replacement) kept.push(fence.replacement)
      index = fence.end
      continue
    }
    const line = lines[index]
    if (legacyHeading(line)) {
      inLegacyHeading = true
      removed += 1
      continue
    }
    if (inLegacyHeading) {
      if (/^\s*#{1,6}\s+/u.test(line)) inLegacyHeading = false
      else if (structuredConditionValueLine(line) || lineIsLegacyCondition(line)) {
        removed += 1
        continue
      } else if (String(line).trim()) {
        inLegacyHeading = false
      }
    }
    if (lineIsLegacyCondition(line)) {
      removed += 1
      continue
    }
    const objects = removeInlineConditionObjects(line)
    const segments = removeInlineConditionSegments(objects.text)
    removed += objects.removed + segments.removed
    const cleanedLine = segments.text.replace(/[ \t]{2,}/g, ' ').trimEnd()
    if (cleanedLine.trim()) kept.push(cleanedLine)
    else if (line.trim()) kept.push(cleanedLine)
  }
  const baseContent = removed ? kept.join('\n').replace(/\n{3,}/g, '\n\n') : normalized
  if (!reviewPackaging) return { content:baseContent, changed:removed > 0, removed }
  const packaged = sanitizeStrategyMemoryReviewPackaging(baseContent)
  return { content:packaged.content, changed:removed > 0 || packaged.changed,
    removed:removed + packaged.removed }
}

export function containsLegacyStrategyMemoryConditions(value) {
  return sanitizeLegacyStrategyMemoryContent(value).changed
}

export const LEGACY_STRATEGY_MEMORY_CONDITION_KEYS = LEGACY_CONDITION_KEYS
