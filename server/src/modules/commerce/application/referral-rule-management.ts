export interface RuleChange { id: number; expectedRevision: string; rateBps: number; enabled: boolean }
export interface RuleChangeCommand { requestId: string; actorUserId: number; changes: RuleChange[] }
export interface RuleChangeResult { rules: { id: number; revision: string }[]; replayed: boolean }
export interface RuleConfiguration { id: string; plan: 'plus' | 'pro'; period: 'monthly' | 'yearly'; rateBps: number; enabled: boolean; revision: string }
export interface ReferralRuleManagementRepository {
  execute(command: RuleChangeCommand): Promise<RuleChangeResult>
  list(actorUserId: number): Promise<RuleConfiguration[]>
}

export function normalizeRuleChangeCommand(command: RuleChangeCommand): RuleChangeCommand {
  if (!command || Object.keys(command).sort().join(',') !== 'actorUserId,changes,requestId'
    || typeof command.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(command.requestId)
    || !Number.isSafeInteger(command.actorUserId) || command.actorUserId < 1 || command.actorUserId > 2147483647
    || !Array.isArray(command.changes) || command.changes.length < 1 || command.changes.length > 4) throw Error('referral_rule_update_invalid')
  const seen = new Set<number>()
  const changes = command.changes.map(change => {
    if (!change || Object.keys(change).sort().join(',') !== 'enabled,expectedRevision,id,rateBps'
      || !Number.isSafeInteger(change.id) || change.id < 1 || change.id > 2147483647 || seen.has(change.id)
      || typeof change.expectedRevision !== 'string' || !/^[1-9]\d{0,19}$/.test(change.expectedRevision)
      || BigInt(change.expectedRevision) >= 18446744073709551615n
      || !Number.isInteger(change.rateBps) || change.rateBps < 0 || change.rateBps > 10000 || typeof change.enabled !== 'boolean') throw Error('referral_rule_update_invalid')
    seen.add(change.id)
    return { id: change.id, expectedRevision: change.expectedRevision, rateBps: change.rateBps, enabled: change.enabled }
  }).sort((a, b) => a.id - b.id)
  return { requestId: command.requestId, actorUserId: command.actorUserId, changes }
}

export class ReferralRuleManagementService {
  constructor(private readonly repository: ReferralRuleManagementRepository) {}
  async list(actor: { userId: number; role: string }) {
    if (actor.role !== 'admin') throw Error('referral_admin_required')
    if (!Number.isSafeInteger(actor.userId) || actor.userId < 1 || actor.userId > 2147483647) throw Error('referral_rule_update_invalid')
    return this.repository.list(actor.userId)
  }
  async update(actor: { userId: number; role: string }, requestId: string, changes: RuleChange[]) {
    if (actor.role !== 'admin') throw Error('referral_admin_required')
    return this.repository.execute(normalizeRuleChangeCommand({ actorUserId: actor.userId, requestId, changes }))
  }
}
