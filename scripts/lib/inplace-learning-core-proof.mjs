import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { readOriginalRows } from './inplace-column-evidence.mjs'

export async function verifyLearningCoreProof(root) {
  const raw = await readFile(new URL('docs/migration/dev-vue-learning-core-upgrade-rehearsal-20260907.json',root))
  if(sha256(raw)!=='d53d3c8cd3508b15a166b61b1db84f64ee011b60fe375a269778b1fe77007f88')throw Error('inplace_learning_core_proof_changed')
  const p=JSON.parse(raw)
  const ids=['inplace_019_01_learning_courses','inplace_019_02_learning_lessons','inplace_019_03_learning_media_references','inplace_019_04_learning_progress']
  if(p.kind!=='learning-core-upgrade/v1'||!p.apply||p.schemaSteps!==62||p.ddlCount!==4||!p.repeated
    ||!p.originalRowsVerified||!p.protectedRowsVerified||p.identity.db!=='dev_vue_m1_source_20260907_02'
    ||p.currentDevVueWritten!==false||JSON.stringify(p.faultSteps)!==JSON.stringify(ids)
    ||p.result.steps.length!==62||!p.result.steps.every(step=>['completed','reconciled'].includes(step.status)))throw Error('inplace_learning_core_proof_invalid')
  for(const file of p.toolManifest) {
    if(!/^[a-zA-Z0-9_./-]+$/.test(file.path)||file.path.split('/').includes('..')
      ||sha256(await readFile(new URL(file.path,root)))!==file.sha256)throw Error('inplace_learning_core_proof_tools_changed')
  }
  return {sha256:sha256(raw),files:p.toolManifest.length,faultRecovered:true}
}
export async function readLearningCoreRows(connection) {
  const result={}
  for(const name of ['learning_courses','learning_lessons','learning_media_references','learning_progress']) {
    const [[exists]]=await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name])
    if(!Number(exists.n)){result[name]=null;continue}
    const [columns]=await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[name])
    result[name]=(await readOriginalRows(connection,[{name,columns:columns.map(row=>row.name),primary:['id']}]))[0]
  }
  return result
}
export function verifyLearningCoreRows(before,after) {
  for(const name of ['learning_courses','learning_lessons','learning_media_references','learning_progress']) {
    if(before[name]!==null){if(JSON.stringify(before[name])!==JSON.stringify(after[name]))throw Error('inplace_learning_core_rows_changed')}
    else if(after[name]!==null && Number(after[name].rows)!==0)throw Error('inplace_learning_core_not_empty')
  }
}
