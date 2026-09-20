import type { PartialCloseHistoryProof, PartialCloseProtectionPlan } from '../domain/partial-close-protection.js'

export interface VerifiedPartialCloseHistoryProof extends PartialCloseHistoryProof {
  readonly evidence: {
    readonly resultHash:string
    readonly orderTicket:string
    readonly taskId:string
    readonly receiptId:string
    readonly completionHash:string
    readonly deals:readonly {ticket:string;dealId:string;factHash:string;provenanceHashes:readonly string[]}[]
  }
  readonly evidenceHash:string
}
export interface PartialCloseHistoryProofReader {
  read(plan:PartialCloseProtectionPlan):Promise<VerifiedPartialCloseHistoryProof|null>
}
