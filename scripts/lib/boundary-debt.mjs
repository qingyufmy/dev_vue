const allowedRules = new Set(['cross-module-internal', 'public-implementation-export', 'domain-dependency', 'source-cycle', 'module-cycle'])

export function boundaryIdentity(finding) {
  const identity = { rule: finding.rule, source: finding.source, target: finding.target }
  if (finding.rule.endsWith('-cycle')) {
    identity.runtime = Boolean(finding.runtime)
    identity.evidence = (finding.evidence ?? []).map(edge => ({ source: edge.source, target: edge.target,
      kind: edge.kind ?? 'unknown', typeOnly: Boolean(edge.typeOnly) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  } else {
    identity.kind = finding.kind ?? 'unknown'
    identity.typeOnly = Boolean(finding.typeOnly)
  }
  return identity
}

export function compareBoundaryDebt(findings, baseline) {
  if (baseline.version !== 1 || !Array.isArray(baseline.entries)) throw new Error('invalid_boundary_baseline')
  const expected = new Map(), actual = new Map()
  for (const entry of baseline.entries) {
    if (!allowedRules.has(entry.finding?.rule) || !entry.owner?.trim() || !entry.reason?.trim() || !/^P[0-7]$/.test(entry.phase)
      || !Number.isSafeInteger(entry.count) || entry.count < 1) throw new Error('invalid_boundary_debt_entry')
    if (!entry.finding.source || !entry.finding.target || entry.finding.source.includes('*') || entry.finding.target.includes('*')) throw new Error('boundary_wildcards_forbidden')
    if (entry.finding.rule.endsWith('-cycle') && !entry.finding.evidence?.length) throw new Error('cycle_evidence_required')
    const key = JSON.stringify(boundaryIdentity(entry.finding))
    if (expected.has(key)) throw new Error('duplicate_boundary_debt')
    expected.set(key, entry)
  }
  for (const finding of findings) {
    const identity = boundaryIdentity(finding), key = JSON.stringify(identity)
    const entry = actual.get(key)
    if (entry) entry.count++
    else actual.set(key, { finding: identity, count: 1 })
  }
  const added = [], stale = []
  for (const [key, entry] of actual) {
    const count = expected.get(key)?.count ?? 0
    if (entry.count > count) added.push({ ...entry, expectedCount: count })
  }
  for (const [key, entry] of expected) {
    const count = actual.get(key)?.count ?? 0
    if (count < entry.count) stale.push({ ...entry, actualCount: count })
  }
  return { passed: !added.length && !stale.length, findingCount: findings.length,
    debtEntryCount: baseline.entries.length, added, stale,
    scope: 'Prevents changes to currently detected server boundary debt; does not establish full architecture compliance.' }
}
