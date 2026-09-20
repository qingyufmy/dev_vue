import type { BridgeCommandService, BridgeCommandTransport } from '../modules/execution/index.js'
import type { BridgeCommandJob } from './task-queues.js'

/** Job names select an operation; payloads carry only the authoritative command identity. */
export function createBridgeCommandProcessor(
  commands: Pick<BridgeCommandService, 'dispatchQueued' | 'reconcileQueued'>,
  transport: BridgeCommandTransport,
) {
  return async (job: { name: string; data: BridgeCommandJob }) => {
    if (!job.data || Object.keys(job.data).length !== 1 || typeof job.data.commandId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(job.data.commandId)) {
      throw new Error('bridge_command_job_invalid')
    }
    if (job.name === 'bridge.command.dispatch') {
      const result = await commands.dispatchQueued(job.data.commandId, transport)
      return { commandId: result.command.id, status: result.command.status, dispatched: result.dispatched }
    }
    if (job.name === 'bridge.command.reconcile') {
      const command = await commands.reconcileQueued(job.data.commandId, transport)
      return { commandId: command.id, status: command.status, dispatched: false }
    }
    throw new Error('bridge_command_job_name_invalid')
  }
}
