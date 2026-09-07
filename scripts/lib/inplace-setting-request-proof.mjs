import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { readOriginalRows } from './inplace-column-evidence.mjs'

export async function verifySettingRequestProof(root) {
  const raw = await readFile(new URL('docs/migration/dev-vue-setting-request-upgrade-rehearsal-20260907.json',root))
  if(sha256(raw)!=='fcf0a7808a49d23d51b6d13876dd3982ca19836ee30604ae3c6bc65519081903')throw Error('inplace_setting_request_proof_changed')
  const p=JSON.parse(raw)
  const ids=['inplace_018_01_system_setting_requests']
  if(p.kind!=='setting-request-upgrade/v1'||!p.apply||p.schemaSteps!==58||p.ddlCount!==1||!p.repeated
    ||!p.originalRowsVerified||!p.protectedRowsVerified||p.identity.db!=='dev_vue_m1_source_20260907_02'
    ||p.currentDevVueWritten!==false||JSON.stringify(p.faultSteps)!==JSON.stringify(ids)
    ||p.result.steps.length!==58||!p.result.steps.every(step=>['completed','reconciled'].includes(step.status)))throw Error('inplace_setting_request_proof_invalid')
  for(const file of p.toolManifest) {
    if(!/^[a-zA-Z0-9_./-]+$/.test(file.path)||file.path.split('/').includes('..')
      ||sha256(await readFile(new URL(file.path,root)))!==file.sha256)throw Error('inplace_setting_request_proof_tools_changed')
  }
  return {sha256:sha256(raw),files:p.toolManifest.length,faultRecovered:true}
}
export async function readSettingRequestUpgradeRows(connection) {
  const result={}
  for(const [name,columns,primary] of [
    ['system_setting_requests',['actor_user_id','request_id','request_sha256','setting_id','revision','recorded_at_utc'],['actor_user_id','request_id']]]) {
    const [[exists]]=await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name])
    result[name]=Number(exists.n)?(await readOriginalRows(connection,[{name,columns,primary}]))[0]:null
  }
  return result
}
export function verifySettingRequestUpgradeRows(before,after) {
  for(const name of ['system_setting_requests']) {
    if(before[name]!==null) { if(JSON.stringify(before[name])!==JSON.stringify(after[name]))throw Error('inplace_setting_request_rows_changed') }
    else if(after[name]!==null && after[name].rows!==0)throw Error('inplace_setting_request_not_empty')
  }
}
