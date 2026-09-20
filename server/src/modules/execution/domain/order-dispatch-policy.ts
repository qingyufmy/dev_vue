import type { EffectiveRiskPolicy } from '../../risk/index.js'
import { BridgeCommandError, type BridgeCommand } from './bridge-command.js'

export function assertOrderDispatchPolicy(command: BridgeCommand, policy: EffectiveRiskPolicy, options?: { skipForManual?: boolean }) {
  if (command.action !== 'order.place') return
  if (policy.userId !== command.userId || policy.accountId !== command.accountId) {
    throw new BridgeCommandError('execution_dispatch_policy_unavailable', 409)
  }
  if (options?.skipForManual) return
  if (policy.globalKillSwitch || policy.values.accountKillSwitch || !policy.values.tradeSendEnabled) {
    throw new BridgeCommandError('execution_dispatch_policy_halted', 409)
  }
  const limit = policy.values.maxOrderVolume
  const volume = Number(command.request.payload.params.volume)
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(volume) || volume <= 0) {
    throw new BridgeCommandError('execution_dispatch_policy_unavailable', 409)
  }
  if (volume > limit + 1e-9) throw new BridgeCommandError('execution_order_volume_exceeded', 409)
}
