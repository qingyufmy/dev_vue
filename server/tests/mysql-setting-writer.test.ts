import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { updateSettingInTransaction } from '../src/modules/settings/infrastructure/mysql-setting-writer.js'
const input = {namespace:'smtp',key:'secure',expectedType:'boolean' as const,expectedRevision:'9007199254740993',value:'true',requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actorUserId:1}
const before = {id:'1',revision:input.expectedRevision,fingerprint:'a'.repeat(64),value_type:'boolean',sensitivity:'restricted'}
function fixture(patch = {}, auditFailure = false) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT')) return [[{...before,...patch,...(execute.mock.calls.length > 2 ? {revision:'9007199254740994',fingerprint:'b'.repeat(64)} : {})}],[]]
    if (sql.startsWith('INSERT') && auditFailure) throw Error('audit_failed')
    return [{affectedRows:1},[]]
  })
  return {execute,c:{execute} as unknown as PoolConnection}
}
it('uses exact revisions and writes the full-snapshot audit on the same connection',async()=>{
  const f=fixture()
  expect(await updateSettingInTransaction(f.c,input,()=>true)).toEqual({id:'1',revision:'9007199254740994'})
  expect(f.execute.mock.calls[1]).toEqual([expect.stringContaining('UPDATE system_settings'),['true','9007199254740994','1',input.expectedRevision]])
  expect(f.execute.mock.calls[3]).toEqual([expect.stringContaining('INSERT INTO system_setting_changes'),['1','9007199254740994',input.requestId,1,'a'.repeat(64),'b'.repeat(64)]])
})
it('rejects stale versions and secret or wrong-type rows before mutation',async()=>{
  for(const patch of [{revision:'2'},{sensitivity:'secret'},{value_type:'credential'}]) {
    const f=fixture(patch)
    await expect(updateSettingInTransaction(f.c,input,()=>true)).rejects.toThrow()
    expect(f.execute).toHaveBeenCalledTimes(1)
  }
})
it('rejects malformed values, identifiers, revisions and semantic policy before SQL',async()=>{
  for(const patch of [{value:'true\n'},{key:'secure\n'},{expectedRevision:'18446744073709551615'},{requestId:input.requestId+'\n'}]) {
    const f=fixture();await expect(updateSettingInTransaction(f.c,{...input,...patch},()=>true)).rejects.toThrow();expect(f.execute).not.toHaveBeenCalled()
  }
  const f=fixture();await expect(updateSettingInTransaction(f.c,input,()=>false)).rejects.toThrow('policy_rejected');expect(f.execute).not.toHaveBeenCalled()
})
it('propagates audit failure for caller rollback without retry or commit',async()=>{
  const f=fixture({},true)
  await expect(updateSettingInTransaction(f.c,input,()=>true)).rejects.toThrow('audit_failed')
  expect(f.execute).toHaveBeenCalledTimes(4)
})
