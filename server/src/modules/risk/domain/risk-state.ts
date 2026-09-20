export interface RiskPolicyValues {
  allowedSymbols: string[]
  requireStopLoss: true
  failClosedOnIncompleteData: true
  maxRiskPerTradePercent: number
  maxDailyLossPercent: number
  maxDrawdownPercent: number
  maxOpenPositions: number
  maxPendingOrders: number
  maxOrderVolume: number
  maxTotalVolume: number
  maxSpreadPoints: number
  maxQuoteAgeSeconds: number
  maxRiskSummaryAgeSeconds: number
  maxDecisionAgeSeconds: number
  maxPriceDeviationPercent: number
  manualReleaseEnabled: boolean
  manualReleaseMaxDailyLossPercent: number
  manualReleaseMaxDrawdownPercent: number
  manualReleaseMaxDailyOpenCount: number
  manualReleaseConsecutiveLossLimit: number
  minOpenIntervalSeconds: number
  maxDailyOpenCount: number
  consecutiveLossLimit: number
  lossCooldownMinutes: number
  pendingValidMinutes: number
  pendingDedupAtrMultiplier: number
  weekendCloseMinutes: number
  tradeSendEnabled: boolean
  accountKillSwitch: boolean
}

export type AccountRiskPolicyPatch = Partial<Pick<RiskPolicyValues,
  'maxRiskPerTradePercent' | 'maxDailyLossPercent' | 'maxDrawdownPercent' |
  'maxOpenPositions' | 'maxPendingOrders' | 'maxOrderVolume' | 'maxTotalVolume' | 'maxSpreadPoints' |
  'minOpenIntervalSeconds' | 'maxDailyOpenCount' | 'consecutiveLossLimit' |
  'lossCooldownMinutes' | 'pendingValidMinutes' | 'weekendCloseMinutes' |
  'tradeSendEnabled' | 'accountKillSwitch'>>

export interface RiskPolicyBoundary {
  values: Omit<RiskPolicyValues, 'tradeSendEnabled' | 'accountKillSwitch'>
  controls?: Partial<Record<keyof RiskPolicyValues, RiskNumericControl>>
  globalKillSwitch: boolean
  revision: number
}

export interface RiskNumericControl {
  allowedMin: number
  allowedMax: number
  lockedValue: number | null
  userEditable: boolean
}

export interface EffectiveRiskPolicy {
  numericControls?: NonNullable<RiskPolicyBoundary['controls']>
  accountId: string
  userId: number
  platformPolicyVersionId: string
  accountPolicyVersionId: string | null
  policySetRevision: number
  globalKillSwitch: boolean
  values: RiskPolicyValues
  editableFields: Array<keyof AccountRiskPolicyPatch>
  updatedAt: string
}

export interface AccountRiskSummary {
  accountId: string
  userId: number
  businessDate: string | null
  equity: string
  freeMargin: string
  marginLevelPercent: number | null
  dailyLossPercent: number
  drawdownPercent: number
  openPositions: number
  pendingOrders: number
  totalVolume: string
  dailyOpenCount: number
  consecutiveLosses: number
  terminalTimezoneOffsetMinutes: number | null
  clockStatus: 'calibrated' | 'observer_bootstrap' | 'stale' | 'unavailable'
  lastSuccessfulOpenAt: string | null
  cooldownUntil: string | null
  dataComplete: boolean
  incompleteReasons: string[]
  observedAt: string
  revision: number
}
