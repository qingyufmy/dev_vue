import { confirmedSegmentEvidence, windowCanObserve, windowHasEvidenceContext, type WindowEvidence, type WindowSegment, type WindowCenter } from './window-evidence.js'
import { confirmedCenterEvidence, stableCenterCoreKey, rebuildConsensusCenterFromCore, summarizeConsensusCenter } from './center-consensus-evidence.js'
interface SupportEntry<C> { candidate: C; center: WindowCenter }

export function selectConsensusCenters<C extends WindowEvidence>(supportCandidates: readonly C[], allCandidates: readonly C[], segments: readonly WindowSegment[], timeframe: string | null,
  authoritativeCandidate: C | null = null, minimumContextBars = 0) {
  const groups = new Map<string, { coreStableIds: string[]; entries: SupportEntry<C>[] }>()
  const hadEvidence = allCandidates.some(candidate => confirmedCenterEvidence(candidate).length > 0)
  const authoritativeCenterKeys = new Set(confirmedCenterEvidence(authoritativeCandidate)
    .map(center => stableCenterCoreKey(center, authoritativeCandidate)).filter(Boolean))
  for (const candidate of supportCandidates) {
    const seen = new Set()
    for (const center of confirmedCenterEvidence(candidate)) {
      const key = stableCenterCoreKey(center, candidate)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const group = groups.get(key) || { coreStableIds:JSON.parse(key) as string[], entries:[] as SupportEntry<C>[] }
      group.entries.push({ candidate, center })
      groups.set(key, group)
    }
  }
  const supported = []
  for (const group of groups.values()) {
    // Suffix windows may confirm a phase chosen by the complete history, but a
    // truncated window is never allowed to create a different center phase.
    if (!authoritativeCenterKeys.has(JSON.stringify(group.coreStableIds))
      || !group.entries.some(entry => entry.candidate === authoritativeCandidate)) continue
    const firstCoreStableId = group.coreStableIds[0]
    const evidenceSegment = group.entries
      .flatMap(entry => confirmedSegmentEvidence(entry.candidate))
      .find(segment => segment?.stable_id === firstCoreStableId)
    const evidenceStart = Number(evidenceSegment?.start_time_utc_msc) || null
    const eligibleCandidates = allCandidates.filter(candidate => (
      windowHasEvidenceContext(candidate, evidenceStart, minimumContextBars)))
    const eligibleSet = new Set(eligibleCandidates)
    const supportEntries = group.entries.filter(entry => eligibleSet.has(entry.candidate))
    if (supportEntries.length < 2 || supportEntries.length * 2 <= eligibleCandidates.length) continue
    const rebuilt = rebuildConsensusCenterFromCore(group.coreStableIds, segments)
    if (!rebuilt) continue
    supported.push({
      ...rebuilt,
      evidenceStart,
      supportEntries,
      supportCount:supportEntries.length,
      validatorCount:eligibleCandidates.length,
    })
  }
  supported.sort((a, b) => a.startIndex - b.startIndex || b.supportCount - a.supportCount)
  let coherent: typeof supported = []
  let jointSupportCandidates = new Set<C>()
  let sequenceEvidenceStart: number | null = null
  for (const option of supported) {
    const previous = coherent.at(-1)
    if (previous) {
      if (previous.departureIndex == null || option.startIndex < previous.departureIndex) {
        coherent = [option]
        jointSupportCandidates = new Set(option.supportEntries.map(entry => entry.candidate))
        sequenceEvidenceStart = option.evidenceStart
        continue
      }
      const optionSupportCandidates = new Set(option.supportEntries.map(entry => entry.candidate))
      const intersection = new Set([...jointSupportCandidates].filter(candidate => optionSupportCandidates.has(candidate)))
      const sequenceEligible = allCandidates.filter(candidate => windowCanObserve(candidate, sequenceEvidenceStart))
      if (intersection.size < 2 || intersection.size * 2 <= sequenceEligible.length) {
        coherent = [option]
        jointSupportCandidates = optionSupportCandidates
        sequenceEvidenceStart = option.evidenceStart
        continue
      }
      jointSupportCandidates = intersection
    } else {
      jointSupportCandidates = new Set(option.supportEntries.map(entry => entry.candidate))
      sequenceEvidenceStart = option.evidenceStart
    }
    coherent.push(option)
  }
  coherent.forEach((option, index) => { option.center.id = index + 1 })
  const centers = coherent.map(option => summarizeConsensusCenter(
    option.center, segments, timeframe, option.supportCount, option.validatorCount)!)
  const latestOption = coherent.at(-1) || null
  return {
    centers,
    hadEvidence,
    latestSupportCount:latestOption?.supportCount || 0,
    latestValidatorCount:latestOption?.validatorCount || 0,
    latestCandidates:latestOption?.supportEntries.map(entry => entry.candidate) || [],
  }
}
