import type { BridgeCommandTransport } from '../../execution/application/bridge-command-ports.js'
import { BridgeCommandError, type BridgeCommand, type BridgeCommandReconcileEnvelope, type BridgeCommandRequestEnvelope } from '../../execution/domain/bridge-command.js'
import type { BridgeGatewayDirectory, BridgeGatewayLeaseStore } from './bridge-gateway-ports.js'

export class BridgeGatewayCommandTransport implements BridgeCommandTransport {
  constructor(
    private readonly leases: BridgeGatewayLeaseStore,
    private readonly directory: BridgeGatewayDirectory,
  ) {}

  async currentRoute(command: BridgeCommand) {
    const current = await this.leases.current(command.accountId)
    return current ? {
      terminalInstanceId: current.terminalInstanceId,
      brokerServer: current.brokerServer,
      login: current.login,
      connectionEpoch: current.connectionEpoch,
    } : null
  }

  async send(message: BridgeCommandRequestEnvelope | BridgeCommandReconcileEnvelope, accountId: string) {
    const current = await this.leases.current(accountId)
    if (!current || current.terminalInstanceId !== message.route.terminal_instance_id
      || current.brokerServer !== message.route.account_ref.broker_server || current.login !== message.route.account_ref.login
      || current.connectionEpoch !== message.route.connection_epoch) {
      throw new BridgeCommandError('bridge_route_unavailable', 409)
    }
    const sink = this.directory.get(current.connectionId)
    if (!sink) throw new BridgeCommandError('bridge_route_process_unavailable', 503)
    await sink.send(message)
  }
}
