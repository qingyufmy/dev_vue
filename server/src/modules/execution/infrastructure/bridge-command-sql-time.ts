import { BridgeCommandError } from '../domain/bridge-command.js'

export function bridgeCommandSqlTime(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new BridgeCommandError('bridge_command_time_invalid', 422)
  }
  return value.slice(0, 23).replace('T', ' ')
}
