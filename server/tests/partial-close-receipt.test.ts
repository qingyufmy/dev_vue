import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { closeReceiptTickets } from '../src/modules/execution/domain/partial-close-receipt.js'
import { canonicalHash } from '../src/modules/execution/domain/bridge-command.js'
import { createMysqlPartialCloseReceiptReader } from '../src/modules/execution/infrastructure/mysql-partial-close-receipt-reader.js'

describe('explicit partial close receipt identities',()=>{
  it('reads the actual nested MT5 result and exact string evidence without using position IDs',()=>{
    expect(closeReceiptTickets({raw_result:{order:201,deal:301,position:101},
      evidence:{order_tickets:['201'],deal_tickets:['302','301'],position_tickets:['101']}},'101'))
      .toEqual({orderTicket:'201',dealTickets:['301','302']})
    expect(closeReceiptTickets({order_ticket:'201',deal_ticket:'301'},'101')).toEqual({orderTicket:'201',dealTickets:['301']})
    expect(closeReceiptTickets({raw_result:{order:'18446744073709551615',deal:'18446744073709551614'}},'101'))
      .toEqual({orderTicket:'18446744073709551615',dealTickets:['18446744073709551614']})
  })
  it.each([null,{}, {ticket:'201',position:'101'}, {raw_result:{position:'101',remaining_volume:'0.02'}},
    {raw_result:{order:201}}, {raw_result:{deal:301}}, {raw_result:{already_absent:true,order:201,deal:301}}])
    ('never treats absence, residual volume or a bare ticket as a filled close %j',value=>{
      expect(closeReceiptTickets(value,'101')).toBeNull()
    })
  it.each([{order:201,raw_result:{order:202,deal:301}}, {raw_result:{order:201,deal:301},evidence:{order_tickets:['202']}},
    {raw_result:{order:201,deal:301},evidence:{deal_tickets:['302']}}, {raw_result:{order:201,deal:301,position:102}},
    {raw_result:{order:201,deal:301},evidence:{position_tickets:['102']}}, {raw_result:{order:201,deal:301},evidence:{deal_tickets:['301','301']}},
    {raw_result:{order:9007199254740992,deal:301}}, {raw_result:{order:'18446744073709551616',deal:301}},
    {raw_result:{order:'0201',deal:301}}, {raw_result:'invalid'}, {evidence:'invalid'}])
    ('rejects conflicting or unrepresentable identities %j',value=>{
      expect(()=>closeReceiptTickets(value,'101')).toThrow()
    })
})
function fixture(terminalCode?:string|number|null) {
  const target={userId:'7',accountId:'5',terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',positionIdentifier:'100',ticket:'101',symbol:'XAUUSD',side:'buy' as const}
  const plan={workflowId:'w',parentIntentId:'i',parentCommandId:'c',target,initialVolume:'0.10',closeVolume:'0.08',initialRevision:5,expiresAt:3000,protection:{stopLoss:'2400'}}
  const request={v:4,type:'command.request',correlation_id:'i',route:{terminal_instance_id:'terminal',account_ref:{broker_server:'Broker',login:'42'},connection_epoch:1},
    payload:{command_id:'c',action:'position.close',issued_at_utc_msc:1000,params:{ticket:'101',volume:'0.08'},expected_state:{ticket:'101',symbol:'XAUUSD',direction:'buy',volume:'0.10'}}}
  const result={raw_result:{order:201,deal:301,position:101},evidence:{order_tickets:['201'],deal_tickets:['301'],position_tickets:['101']}}
  const payload={command_id:'c',action:'position.close',status:'succeeded',completed_at_utc_msc:2000,result,error_code:null,
    ...(terminalCode===undefined?{}:{terminal_code:terminalCode})}
  const row={request_sha256:canonicalHash(request.payload),request_envelope_json:request,connection_epoch:1,issued_msc:'1000',completed_msc:'2000',
    result_completed_msc:'2000',result_json:result,result_sha256:canonicalHash(payload),error_code:null,terminal_code:terminalCode==null?null:String(terminalCode)}
  const execute=vi.fn(async()=>[[row]])
  return {plan,row,request,result,execute,reader:createMysqlPartialCloseReceiptReader({execute} as unknown as PoolConnection)}
}
describe('persisted partial close result anchor',()=>{
  it.each([10009,'10009',10009.5,null,undefined])('verifies the immutable hash despite SQL terminal_code text encoding %s',async code=>{
    const f=fixture(code)
    const receipt=await f.reader.read(f.plan)
    expect(receipt).toEqual({parentIntentId:'i',parentCommandId:'c',target:f.plan.target,issuedAt:1000,completedAt:2000,connectionEpoch:1,
      resultHash:f.row.result_sha256,orderTicket:'201',dealTickets:['301']})
    expect(receipt!.target).not.toBe(f.plan.target)
  })
  it('returns null for an absent terminal result and does not query another command',async()=>{
    const f=fixture();f.execute.mockResolvedValueOnce([[]])
    await expect(f.reader.read(f.plan)).resolves.toBeNull()
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it.each(['issued_msc','completed_msc','result_completed_msc','request_sha256','result_sha256','error_code','connection_epoch'] as const)
    ('rejects corrupt persisted %s',async key=>{
      const f=fixture();Object.assign(f.row,{[key]:key==='connection_epoch'?2:'bad'})
      await expect(f.reader.read(f.plan)).rejects.toThrow('partial_close_receipt_corrupt')
    })
  it('rejects a changed frozen request even if its own hash is recalculated',async()=>{
    const f=fixture();f.request.payload.params.volume='0.07';f.row.request_sha256=canonicalHash(f.request.payload)
    await expect(f.reader.read(f.plan)).rejects.toThrow('partial_close_receipt_corrupt')
  })
  it('rejects changed result content rather than trusting matching database hash columns',async()=>{
    const f=fixture();f.result.raw_result.order=202
    await expect(f.reader.read(f.plan)).rejects.toThrow('partial_close_receipt_corrupt')
  })
})
