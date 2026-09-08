import { BridgeCommandError, type BridgeCommandTransport, type BridgeCommand, type BridgeCommandReconcileEnvelope, type BridgeCommandRequestEnvelope } from '../../execution/index.js'
import type { BridgeGatewayDirectory, BridgeGatewayLeaseStore, BridgeGatewayRouteRepository } from './bridge-gateway-ports.js'

export class BridgeGatewayCommandTransport implements BridgeCommandTransport {
  constructor(
    private readonly leases: BridgeGatewayLeaseStore,
    private readonly directory: BridgeGatewayDirectory,
    private readonly authorization: Pick<BridgeGatewayRouteRepository, 'isAuthorized'>,
  ) {}

  async currentRoute(command: BridgeCommand) {
    const current = await this.leases.current(command.accountId)
    return current && current.userId === command.userId && current.terminalProfileId === command.terminalProfileId
      && await this.authorization.isAuthorized(current) ? {
      terminalInstanceId: current.terminalInstanceId,
      brokerServer: current.brokerServer,
      login: current.login,
      connectionEpoch: current.connectionEpoch,
    } : null
  }

  async send(message: BridgeCommandRequestEnvelope | BridgeCommandReconcileEnvelope, accountId: string,
    scope: Pick<BridgeCommand, 'userId' | 'terminalProfileId'>) {
    const current = await this.leases.current(accountId)
    if (!current || !scope || current.userId !== scope.userId || current.terminalProfileId !== scope.terminalProfileId
      || current.terminalInstanceId !== message.route.terminal_instance_id
      || current.brokerServer !== message.route.account_ref.broker_server || current.login !== message.route.account_ref.login
      || current.connectionEpoch !== message.route.connection_epoch) {
      throw new BridgeCommandError('bridge_route_unavailable', 409)
    }
    if (!await this.authorization.isAuthorized(current)) throw new BridgeCommandError('bridge_route_authorization_revoked', 403)
    if ((await this.leases.current(accountId))?.connectionId !== current.connectionId) {
      throw new BridgeCommandError('bridge_route_unavailable', 409)
    }
    const sink = this.directory.get(current.connectionId)
    if (!sink) throw new BridgeCommandError('bridge_route_process_unavailable', 503)
    await sink.send(message)
  }
}
