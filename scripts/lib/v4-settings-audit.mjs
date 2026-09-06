import { exactKeys, hash, canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { inspectSettingValue } from './v4-settings-value-contract.mjs'
export const settingsAuditFields = Object.freeze(['id','namespace','setting_key','value_type','value_text','sensitivity','label','sort_order','created_at_utc','updated_at_utc','revision','origin','migration_run_id','source_sha256','imported_at_utc'])
// Independent SQL readback audit: does not import the converter or writer.
export function auditSettingsImport(sources, actual, archives, {run,basis,evidenceCatalog}) {
  check(Array.isArray(sources)&&Array.isArray(actual)&&Array.isArray(archives)&&evidenceCatalog instanceof Map,'settings_audit_input')
  exactKeys(run,['id','sourceSnapshotId','registeredAtUtc'])
  check(typeof run.id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    &&typeof run.sourceSnapshotId==='string'&&run.sourceSnapshotId.length>0
    &&typeof run.registeredAtUtc==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc),'settings_audit_run')
  const registered=inspectWallClock(run.registeredAtUtc.replace('T',' ').slice(0,-1)).canonicalWallClock
  const sorted=[...sources].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1)
  exactKeys(basis,['version','sourceHash','sourceSnapshotId','resolutions'])
  check(basis.version==='settings-import/v1'&&basis.sourceHash===hash(sorted)&&basis.sourceSnapshotId===run.sourceSnapshotId
    &&Array.isArray(basis.resolutions)&&basis.resolutions.length===sources.length,'settings_audit_basis')
  const unique=(rows,key)=>{const map=new Map();for(const row of rows){check(typeof row[key]==='string'&&!map.has(row[key]),'settings_audit_duplicate');map.set(row[key],row)}return map}
  unique(sorted,'id')
  const resolutions=unique(basis.resolutions,'sourceId'),targets=unique(actual,'id'),saved=unique(archives,'sourceId'),differences=[]
  const add=(id,field,code)=>differences.push({sourceId:id,field,code})
  const proof=item=>check(typeof item.evidenceId==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(item.evidenceId)&&typeof item.evidenceSha256==='string'
    &&/^[a-f0-9]{64}$/.test(item.evidenceSha256)&&evidenceCatalog.get(item.evidenceId)===item.evidenceSha256,'settings_audit_evidence')
  const utc=(raw,item)=>{
    exactKeys(item,['raw','kind','offsetMinutes','evidenceId','evidenceSha256']);proof(item);check(item.raw===raw,'settings_audit_time_binding')
    if(raw===null){check(item.kind==='source_null'&&item.offsetMinutes===null,'settings_audit_null');return null}
    check(item.kind==='wall_clock'&&Number.isInteger(item.offsetMinutes)&&Math.abs(item.offsetMinutes)<=840,'settings_audit_offset')
    const date=new Date(Date.parse(inspectWallClock(raw).canonicalWallClock.replace(' ','T')+'Z')-item.offsetMinutes*60000)
    check(date.getUTCFullYear()>=1000&&date.getUTCFullYear()<=9999,'settings_audit_time_range');return date.toISOString().replace('T',' ').slice(0,-1)
  }
  for(const source of sorted){
    exactKeys(source,['id','category','key','value','label','sort_order','created_at','updated_at'])
    const id=source.id,resolution=resolutions.get(id),sourceHash=hash(source),rule=inspectSettingValue(source.category,source.key,source.value)
    check(rule.compatible&&resolution?.sourceHash===sourceHash,'settings_audit_resolution')
    exactKeys(resolution,['sourceId','sourceHash','createdAt','updatedAt','valueEvidence'])
    exactKeys(resolution.valueEvidence,['evidenceId','evidenceSha256','requirements']);proof(resolution.valueEvidence)
    check(Array.isArray(resolution.valueEvidence.requirements)&&canonical([...resolution.valueEvidence.requirements].sort())===canonical([...new Set(['semantic_review',...rule.needs])].sort()),'settings_audit_semantics')
    const expected={id,namespace:source.category,setting_key:source.key,value_type:rule.type,value_text:source.value,sensitivity:rule.exposure,label:source.label,sort_order:source.sort_order,
      created_at_utc:utc(source.created_at,resolution.createdAt),updated_at_utc:utc(source.updated_at,resolution.updatedAt),revision:'1',origin:'legacy_import',migration_run_id:run.id,source_sha256:sourceHash,imported_at_utc:registered}
    const target=targets.get(id)
    if(!target)add(id,'target','missing')
    else {exactKeys(target,settingsAuditFields);for(const field of settingsAuditFields){const value=field.endsWith('_at_utc')?inspectWallClock(target[field]).canonicalWallClock:target[field];if(value!==expected[field])add(id,field,'value_mismatch')}}
    const archive=saved.get(id)
    if(!archive)add(id,'archive','missing')
    else {
      if(archive.runId!==run.id||archive.sourceHash!==sourceHash||archive.sourcePkHash!==hash([{type:'integer',value:id}]))add(id,'archive','identity_mismatch')
      const payload={version:1,sourceTable:'system_config',projection:'settings-source/v1',source,sourceSnapshotId:run.sourceSnapshotId,registeredAtUtc:run.registeredAtUtc,basisHash:hash(basis),resolution}
      if(canonical(archive.payload)!==canonical(payload))add(id,'archive','payload_mismatch')
    }
    targets.delete(id);saved.delete(id)
  }
  for(const id of targets.keys())add(id,'target','unexpected')
  for(const id of saved.keys())add(id,'archive','unexpected')
  return {version:'settings-import-audit/v1',sourceRows:sources.length,targetRows:actual.length,archiveRows:archives.length,differences,
    importMatchesReviewedInputs:differences.length===0,checkedTargetFields:settingsAuditFields,evidenceCatalogExternallyRequired:true,consumersSwitched:false,deletionAuthorized:false}
}
