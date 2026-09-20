import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { PartialCloseReceiptReader } from '../application/partial-close-receipt-reader.js'
import { canonicalHash, type BridgeCommandRequestEnvelope } from '../domain/bridge-command.js'
import { closeReceiptTickets } from '../domain/partial-close-receipt.js'

interface ReceiptRow extends RowDataPacket {
  request_sha256:string; request_envelope_json:string|BridgeCommandRequestEnvelope; connection_epoch:number|string
  issued_msc:string; completed_msc:string; result_completed_msc:string; result_json:unknown
  result_sha256:string; error_code:string|null; terminal_code:string|null
}
const parse = <T>(value:string|T):T => typeof value === 'string' ? JSON.parse(value) as T : value
const time = (value:unknown):number|null => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value)) return null
  const number=Number(value)
  return Number.isSafeInteger(number) && Number.isFinite(new Date(number).getTime()) ? number : null
}
const decimal = (value:unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value)
  ? value.includes('.') ? value.replace(/0+$/,'').replace(/\.$/,'') : value : null
const equalVolume = (left:unknown,right:unknown) => decimal(left)!==null && decimal(left)===decimal(right)

export function createMysqlPartialCloseReceiptReader(connection:Pick<PoolConnection,'execute'>):PartialCloseReceiptReader {
  return { async read(input) {
    const plan=structuredClone(input), target=plan.target
    const [rows]=await connection.execute<ReceiptRow[]>(`SELECT c.request_sha256,p.request_envelope_json,c.connection_epoch,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',c.issued_at_utc) DIV 1000 AS CHAR) issued_msc,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',c.completed_at_utc) DIV 1000 AS CHAR) completed_msc,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.completed_at_utc) DIV 1000 AS CHAR) result_completed_msc,
      r.result_json,r.result_sha256,r.error_code,r.terminal_code
      FROM execution_intents i INNER JOIN bridge_commands_v4 c ON c.execution_intent_id=i.id
        AND c.user_id=i.user_id AND c.trading_account_id=i.trading_account_id
      INNER JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id
      INNER JOIN bridge_command_results_v4 r ON r.bridge_command_id=c.id AND r.message_id=c.result_message_id AND r.result_sha256=c.result_sha256
      WHERE i.id=? AND c.id=? AND i.user_id=? AND i.trading_account_id=?
        AND i.action_kind='close_position' AND i.status='succeeded' AND c.action='position.close' AND c.status='succeeded'
        AND r.action='position.close' AND r.status='succeeded' AND r.conflict=0
        AND BINARY c.terminal_instance_id=BINARY ? AND BINARY c.broker_server=BINARY ? AND BINARY c.account_login=BINARY ? LIMIT 2`,
    [plan.parentIntentId,plan.parentCommandId,target.userId,target.accountId,target.terminalInstanceId,target.brokerServer,target.login])
    if (rows.length===0) return null
    if (rows.length!==1) throw Error('partial_close_receipt_ambiguous')
    const row=rows[0]!, issuedAt=time(row.issued_msc), completedAt=time(row.completed_msc)
    if (issuedAt===null || completedAt===null || time(row.result_completed_msc)!==completedAt || completedAt<issuedAt
      || row.error_code!==null) throw Error('partial_close_receipt_corrupt')
    let request:BridgeCommandRequestEnvelope, result:unknown
    try { request=parse(row.request_envelope_json);result=parse(row.result_json) }
    catch { throw Error('partial_close_receipt_corrupt') }
    const expected=request?.payload?.expected_state
    if (!request || request.v!==4 || request.type!=='command.request' || request.correlation_id!==plan.parentIntentId
      || request.payload.command_id!==plan.parentCommandId || request.payload.action!=='position.close'
      || canonicalHash(request.payload)!==row.request_sha256 || request.payload.issued_at_utc_msc!==issuedAt
      || request.payload.params.ticket!==target.ticket || !equalVolume(request.payload.params.volume,plan.closeVolume)
      || !expected || expected.ticket!==target.ticket || expected.symbol!==target.symbol || expected.direction!==target.side
      || !equalVolume(expected.volume,plan.initialVolume) || request.route.terminal_instance_id!==target.terminalInstanceId
      || request.route.account_ref.broker_server!==target.brokerServer || request.route.account_ref.login!==target.login
      || !Number.isSafeInteger(request.route.connection_epoch) || request.route.connection_epoch<1
      || Number(row.connection_epoch)!==request.route.connection_epoch) throw Error('partial_close_receipt_corrupt')
    const payload={command_id:plan.parentCommandId,action:'position.close',status:'succeeded',completed_at_utc_msc:completedAt,result,error_code:null}
    // Ledger stores terminal_code as text. Check only encodings allowed by the wire contract, against the original immutable hash.
    const candidates:unknown[]=row.terminal_code===null ? [payload,{...payload,terminal_code:null}]
      : [{...payload,terminal_code:row.terminal_code}]
    if (row.terminal_code!==null && Number.isFinite(Number(row.terminal_code)) && String(Number(row.terminal_code))===row.terminal_code) {
      candidates.push({...payload,terminal_code:Number(row.terminal_code)})
    }
    if (!candidates.some(value=>canonicalHash(value)===row.result_sha256)) throw Error('partial_close_receipt_corrupt')
    const tickets=closeReceiptTickets(result,target.ticket)
    if (!tickets) return null
    return {...tickets,parentIntentId:plan.parentIntentId,parentCommandId:plan.parentCommandId,target:{...target},
      issuedAt,completedAt,connectionEpoch:request.route.connection_epoch,resultHash:row.result_sha256}
  } }
}
