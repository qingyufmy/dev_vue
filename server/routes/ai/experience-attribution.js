const EXPERIENCE_REF_PATTERN = /^(?:platform|short|long|summary|item):(\d+)$/

// Keep the positive vocabulary deliberately narrow: a model must explicitly
// point at a memory/experience, not merely use a generic word such as
// “适用” or “符合”.
const STRONG_ADOPTION_PATTERNS = [
  /(?:采用|采纳|使用)\s*(?:了\s*)?(?:(?:平台|个人|长期|短期|月度)?(?:经验|记忆)|[#＃]\s*\d+|(?:平台|个人|长期|短期|月度)?(?:经验|记忆)\s*\d+|(?:platform|short|long|summary|item):\d+)/,
  /参考(?:了|过|该|此|这一)\s*(?:(?:平台|个人|长期|短期|月度)?(?:经验|记忆)|[#＃]\s*\d+|(?:平台|个人|长期|短期|月度)?(?:经验|记忆)\s*\d+|(?:platform|short|long|summary|item):\d+)/,
  /(?:依据|按照|遵循|符合|适用)\s*(?:该|此|这一)?\s*(?:经验|记忆)/,
  /(?:该|此|这一)?\s*(?:经验|记忆)[^。！？!?；;\n]{0,100}(?:因此|所以|故|符合|适用)/,
]

const REJECTION_PATTERN = /(?:未|没有|不|并未)\s*(?:采用|采纳|使用|参考|依据|按照|遵循|符合|适用)|(?:适用|适配)(?:范围|性)?\s*(?:不足|有限|不够|不完全|不匹配)|(?:不完全|未完全|并不完全|不太|不够)\s*(?:适用|符合|匹配)|(?:不匹配|不相符|不一致|不符合)/

function list(value) {
  return Array.isArray(value) ? value : []
}

function numericIds(value) {
  return [...new Set(list(value).map(Number).filter(id => Number.isInteger(id) && id > 0))]
}

export function normalizeExperienceRefs(value) {
  return [...new Set(list(value).map(item => String(item || '').trim()).filter(item => EXPERIENCE_REF_PATTERN.test(item)))]
}

function mentionedExperienceIds(text) {
  const ids = []
  for (const match of String(text || '').matchAll(/(?:记忆|经验)\s*[#＃]?\s*(\d+)|[#＃]\s*(\d+)/g)) {
    const id = Number(match[1] || match[2])
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function hasStrongAdoption(text) {
  return STRONG_ADOPTION_PATTERNS.some(pattern => pattern.test(text))
}

function hasRejection(text) {
  return REJECTION_PATTERN.test(text)
}

/**
 * Normalize structured memory attribution and recover only unambiguous
 * adoption claims from the model's bounded influence text. This helper has no
 * database or model dependencies so live and historical presentation paths
 * cannot drift apart.
 */
export function normalizeExperienceAttribution({
  availableIds = [], availableRefs = [], usedIds = [], usedRefs = [], rejectedIds = [], rejectedRefs = [], influence = '',
} = {}) {
  const refs = normalizeExperienceRefs(availableRefs)
  const ids = [...new Set([...numericIds(availableIds), ...refs.map(ref => Number(ref.match(EXPERIENCE_REF_PATTERN)[1]))])]
  const allowedIds = new Set(ids)
  const allowedRefs = new Set(refs)
  const validIds = value => numericIds(value).filter(id => allowedIds.has(id))
  const validRefs = value => normalizeExperienceRefs(value).filter(ref => allowedRefs.has(ref))
  const refsById = new Map()
  for (const ref of refs) {
    const id = Number(ref.match(EXPERIENCE_REF_PATTERN)[1])
    const matches = refsById.get(id) || []
    matches.push(ref)
    refsById.set(id, matches)
  }
  const uniqueRefsForIds = value => validIds(value).flatMap(id => {
    const matches = refsById.get(id) || []
    return matches.length === 1 ? matches : []
  })
  const uniqueIdsForRefs = value => validRefs(value).flatMap(ref => {
    const id = Number(ref.match(EXPERIENCE_REF_PATTERN)[1])
    const matches = refsById.get(id) || []
    return matches.length === 1 ? [id] : []
  })

  const explicitUsedIds = validIds(usedIds)
  const explicitUsedRefs = validRefs(usedRefs)
  let normalizedUsedIds = [...new Set([...explicitUsedIds, ...uniqueIdsForRefs(explicitUsedRefs)])]
  let normalizedUsedRefs = [...new Set([...explicitUsedRefs, ...uniqueRefsForIds(explicitUsedIds)])]
  let normalizedRejectedIds = [...new Set([...validIds(rejectedIds), ...uniqueIdsForRefs(rejectedRefs)])]
  let normalizedRejectedRefs = [...new Set([
    ...validRefs(rejectedRefs),
    ...uniqueRefsForIds(normalizedRejectedIds),
  ])]

  const text = String(influence || '')
  if (!normalizedUsedIds.length && !normalizedUsedRefs.length && text && !hasRejection(text) && hasStrongAdoption(text)) {
    const mentionedIds = mentionedExperienceIds(text)
    const directRefs = refs.filter(ref => text.includes(ref))
      .filter(ref => (refsById.get(Number(ref.match(EXPERIENCE_REF_PATTERN)[1])) || []).length === 1)
    const inferredRefs = [...new Set([...directRefs, ...uniqueRefsForIds(mentionedIds)])]
    // An unnumbered claim is safe only with one retrieved candidate. If the
    // text names an id/ref, an unknown or ambiguous name must fail closed.
    if (inferredRefs.length || (!mentionedIds.length && !directRefs.length && refs.length === 1)) {
      normalizedUsedRefs = inferredRefs.length ? inferredRefs : [refs[0]]
      normalizedUsedIds = uniqueIdsForRefs(normalizedUsedRefs)
    }
  }

  normalizedRejectedIds = normalizedRejectedIds.filter(id => !normalizedUsedIds.includes(id))
  normalizedRejectedRefs = normalizedRejectedRefs.filter(ref => !normalizedUsedRefs.includes(ref))
  return {
    considered_ids:ids,
    used_ids:normalizedUsedIds,
    rejected_ids:normalizedRejectedIds,
    considered_refs:refs,
    used_refs:normalizedUsedRefs,
    rejected_refs:normalizedRejectedRefs,
  }
}
