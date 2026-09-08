/** Risk owns the shape it evaluates, independent of how AI or a user proposed it. */
export type RiskJsonValue = null | boolean | number | string | RiskJsonValue[] | { [key: string]: RiskJsonValue }
export type RiskJsonObject = { [key: string]: RiskJsonValue }
export type RiskActionKind = 'market_order' | 'pending_order' | 'modify_position' | 'close_position' | 'modify_order' | 'cancel_order'
export interface RiskAction {
  actionId: string
  kind: RiskActionKind
  parameters: RiskJsonObject
  expectedState: RiskJsonObject
}
export interface RiskDecisionInput {
  action: 'hold' | RiskActionKind
  actions: RiskAction[]
}
