/** Bound to the case-write transaction. Frozen evidence must still match its owning domains. */
export interface ManualCandidateSourceVerifier {
  verify(payload: Record<string, unknown>, userId: number): Promise<void>
}
