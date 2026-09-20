import { confirmedSegmentEvidence, windowCanObserve, type WindowEvidence, type WindowSegment } from './window-evidence.js'

export function buildCrossWindowConsensusSegments(winnerCandidates: readonly WindowEvidence[], allCandidates: readonly WindowEvidence[] = winnerCandidates) {
  const representative = [...winnerCandidates].sort((a, b) => (
    confirmedSegmentEvidence(b).length - confirmedSegmentEvidence(a).length
    || Number(b.raw_bar_count || 0) - Number(a.raw_bar_count || 0)
  ))[0]
  const segments = confirmedSegmentEvidence(representative)
  if (segments.length < 2) return { segments:[], pairSupport:[] }
  let confirmedChain = null
  for (let start = 0; start <= segments.length - 2; start++) {
    const chain = segments.slice(start)
    const evidenceStart = Number(chain[0]?.start_time_utc_msc) || null
    const eligible = allCandidates.filter(candidate => windowCanObserve(candidate, evidenceStart))
    const support = eligible.filter(candidate => candidateEndsWithSegmentChain(candidate, chain)).length
    const pairEvidence = chain.slice(0, -1).map((segment, index) => {
      const next = chain[index + 1]!
      const pairStart = Number(segment?.start_time_utc_msc) || null
      const pairEligible = allCandidates.filter(candidate => windowCanObserve(candidate, pairStart))
      const pairSupport = pairEligible.filter(candidate => candidateEndsWithSegmentChain(
        candidate, chain.slice(index))).length
      return {
        segment,
        next,
        support:pairSupport,
        eligible:pairEligible.length,
        confirmed:pairSupport >= 2 && pairSupport * 2 > pairEligible.length,
      }
    })
    const wholeChainConfirmed = support >= 2 && support * 2 > eligible.length
    if (wholeChainConfirmed && pairEvidence.every(item => item.confirmed)) {
      confirmedChain = { segments:chain, support, eligible:eligible.length, pairEvidence }
      break
    }
  }
  if (!confirmedChain) return { segments:[], pairSupport:[] }
  return {
    segments:confirmedChain.segments,
    supportCount:confirmedChain.support,
    validatorCount:confirmedChain.eligible,
    pairSupport:confirmedChain.pairEvidence.map(item => ({
      previous_stable_id:item.segment.stable_id,
      current_stable_id:item.next.stable_id,
      support_count:item.support,
      validator_count:item.eligible,
    })),
  }
}

export function candidateEndsWithSegmentChain(candidate: WindowEvidence | null | undefined, chain: readonly WindowSegment[]) {
  if (!chain.length) return true
  const candidateIds = confirmedSegmentEvidence(candidate).map(segment => segment?.stable_id)
  const chainIds = chain.map(segment => segment?.stable_id)
  const start = candidateIds.length - chainIds.length
  return start >= 0 && chainIds.every((id, index) => id && candidateIds[start + index] === id)
}
