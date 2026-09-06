import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { readOriginalRows } from './inplace-column-evidence.mjs'

export async function verifySettingsProof(root) {
  const raw = await readFile(new URL('docs/migration/dev-vue-settings-upgrade-rehearsal-20260907.json',root))
  if(sha256(raw)!=='947a02e9fdbbcff63f4afdf2447f780fb6b2165f2f0d14454184297bd2343c7d')throw Error('inplace_settings_proof_changed')
  const p=JSON.parse(raw)
  const ids=['inplace_017_01_system_settings','inplace_017_02_system_setting_changes','inplace_017_03_system_settings_exact_tokens']
  if(p.kind!=='settings-upgrade/v1'||!p.apply||p.schemaSteps!==57||p.ddlCount!==3||!p.repeated
    ||!p.originalRowsVerified||!p.protectedRowsVerified||p.identity.db!=='dev_vue_m1_source_20260907_02'
    ||p.currentDevVueWritten!==false||JSON.stringify(p.faultSteps)!==JSON.stringify(ids)
    ||p.result.steps.length!==57||!p.result.steps.every(step=>['completed','reconciled'].includes(step.status)))throw Error('inplace_settings_proof_invalid')
  for(const file of p.toolManifest) {
    if(!/^[a-zA-Z0-9_./-]+$/.test(file.path)||file.path.split('/').includes('..')
      ||sha256(await readFile(new URL(file.path,root)))!==file.sha256)throw Error('inplace_settings_proof_tools_changed')
  }
  return {sha256:sha256(raw),files:p.toolManifest.length,faultRecovered:true}
}
export async function readSettingsUpgradeRows(connection) {
  const result={}
  for(const [name,columns,primary] of [
    ['system_settings',['id','namespace','setting_key','value_type','value_text','sensitivity','label','sort_order','created_at_utc','updated_at_utc','revision','origin','migration_run_id','source_sha256','imported_at_utc'],['id']],
    ['system_setting_changes',['setting_id','revision','request_id','actor_user_id','previous_sha256','current_sha256','recorded_at_utc'],['setting_id','revision']]]) {
    const [[exists]]=await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name])
    result[name]=Number(exists.n)?(await readOriginalRows(connection,[{name,columns,primary}]))[0]:null
  }
  return result
}
export function verifySettingsUpgradeRows(before,after) {
  for(const name of ['system_settings','system_setting_changes']) {
    if(before[name]!==null) { if(JSON.stringify(before[name])!==JSON.stringify(after[name]))throw Error('inplace_settings_rows_changed') }
    else if(after[name]!==null && after[name].rows!==0)throw Error('inplace_settings_not_empty')
  }
}
