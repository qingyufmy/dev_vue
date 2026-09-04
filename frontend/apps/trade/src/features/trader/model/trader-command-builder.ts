import type {
  ExecutionCommand,
  ExecutionCommandContext,
  ExecutionDistribution,
  OpenPosition,
  PendingOrder,
} from '@aurum/contracts'
import type { TraderEntryCommandDraft, TraderResourceEditDraft } from './trader-command-drafts'
import { isPosition } from './trader-presentation'

export function buildDistributionEntryCommand(draft: TraderEntryCommandDraft): ExecutionDistribution['command'] {
  if (draft.command_type === 'market_order') {
    return {
      command_type: 'market_order',
      side: draft.side ?? 'buy',
      symbol: draft.symbol,
      volume: draft.volume,
      stop_loss: draft.stop_loss,
      reference_price: draft.reference_price,
      ...(draft.take_profit ? { take_profit: draft.take_profit } : {}),
    }
  }
  return {
    command_type: 'pending_order',
    order_type: draft.order_type ?? 'buy_limit',
    symbol: draft.symbol,
    volume: draft.volume,
    stop_loss: draft.stop_loss,
    reference_price: draft.reference_price,
    price: draft.price ?? '',
    ...(draft.stop_limit_price ? { stop_limit_price: draft.stop_limit_price } : {}),
    ...(draft.take_profit ? { take_profit: draft.take_profit } : {}),
    ...(draft.expiration_utc_msc ? { expiration_utc_msc: draft.expiration_utc_msc } : {}),
  }
}

export function buildAccountEntryCommand(draft: TraderEntryCommandDraft, context: ExecutionCommandContext): ExecutionCommand {
  const command = buildDistributionEntryCommand(draft)
  return { ...command, expected_state: context.expectedState }
}

export function buildResourceEditCommand(
  resource: OpenPosition | PendingOrder,
  draft: TraderResourceEditDraft,
  context: ExecutionCommandContext,
): ExecutionCommand | null {
  if (!context.targetRevision || context.ticket !== resource.ticket) return null
  const expected_state = { ...context.expectedState, resource_revision: context.targetRevision }
  if (isPosition(resource)) {
    return {
      command_type: 'modify_position',
      ticket: resource.ticket,
      ...(draft.stop_loss ? { stop_loss: draft.stop_loss } : {}),
      ...(draft.remove_stop_loss ? { remove_stop_loss: true as const } : {}),
      ...(draft.take_profit ? { take_profit: draft.take_profit } : {}),
      ...(draft.remove_take_profit ? { remove_take_profit: true as const } : {}),
      expected_state,
    }
  }
  return {
    command_type: 'modify_order',
    ticket: resource.ticket,
    ...(draft.price ? { price: draft.price } : {}),
    ...(draft.stop_limit_price ? { stop_limit_price: draft.stop_limit_price } : {}),
    ...(draft.stop_loss ? { stop_loss: draft.stop_loss } : {}),
    ...(draft.remove_stop_loss ? { remove_stop_loss: true as const } : {}),
    ...(draft.take_profit ? { take_profit: draft.take_profit } : {}),
    ...(draft.remove_take_profit ? { remove_take_profit: true as const } : {}),
    ...(draft.expiration_utc_msc ? { expiration_utc_msc: draft.expiration_utc_msc } : {}),
    ...(draft.remove_expiration ? { remove_expiration: true as const } : {}),
    expected_state,
  }
}

export function buildResourceDestructiveCommand(
  resource: OpenPosition | PendingOrder,
  context: ExecutionCommandContext,
): ExecutionCommand | null {
  if (!context.targetRevision || context.ticket !== resource.ticket) return null
  const expected_state = { ...context.expectedState, resource_revision: context.targetRevision }
  return isPosition(resource)
    ? { command_type: 'close_position', ticket: resource.ticket, expected_state }
    : { command_type: 'cancel_order', ticket: resource.ticket, expected_state }
}
