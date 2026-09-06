import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { inspectSettingValue } from './v4-settings-value-contract.mjs'

const sourceFields = ['id','category','key','value','label','sort_order','created_at','updated_at']
export function prepareSettingsRows(input, { run, basis, evidenceCatalog }) {
  exactKeys(run,['id','sourceSnapshotId','registeredAtUtc'])
  check(typeof run.id==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId==='string' && run.sourceSnapshotId.length>0
    && typeof run.registeredAtUtc==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc),'settings_run_invalid')
  const imported=inspectWallClock(run.registeredAtUtc.replace('T',' ').slice(0,-1)).canonicalWallClock
  check(Array.isArray(input) && evidenceCatalog instanceof Map,'settings_source_invalid')
  const rows=structuredClone(input), ids=new Set(), names=new Set()
  for(const row of rows) {
    exactKeys(row,sourceFields)
    represent(row.id,'int',false);represent(row.category,'varchar(100)',false);represent(row.key,'varchar(100)',false)
    represent(row.label,'varchar(255)',true);represent(row.sort_order,'int',true)
    inspectWallClock(row.created_at);inspectWallClock(row.updated_at)
    check(BigInt(row.id)>0n && !ids.has(row.id),'settings_source_id');ids.add(row.id)
    const name=JSON.stringify([row.category,row.key]);check(!names.has(name),'settings_source_duplicate');names.add(name)
  }
  rows.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1)
  exactKeys(basis,['version','sourceHash','sourceSnapshotId','resolutions'])
  check(basis.version==='settings-import/v1' && basis.sourceHash===hash(rows) && basis.sourceSnapshotId===run.sourceSnapshotId
    && Array.isArray(basis.resolutions) && basis.resolutions.length===rows.length,'settings_basis_scope')
  const resolutions=new Map()
  for(const resolution of basis.resolutions) {
    exactKeys(resolution,['sourceId','sourceHash','createdAt','updatedAt','valueEvidence'])
    check(!resolutions.has(resolution.sourceId),'settings_basis_duplicate');resolutions.set(resolution.sourceId,resolution)
  }
  const evidence = item => {
    check(typeof item.evidenceId==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.evidenceId)
      && typeof item.evidenceSha256==='string' && /^[a-f0-9]{64}$/.test(item.evidenceSha256)
      && evidenceCatalog.get(item.evidenceId)===item.evidenceSha256,'settings_evidence_missing')
  }
  const time = (raw,rule) => {
    exactKeys(rule,['raw','kind','offsetMinutes','evidenceId','evidenceSha256']);evidence(rule)
    check(rule.raw===raw,'settings_time_binding')
    if(raw===null){check(rule.kind==='source_null' && rule.offsetMinutes===null,'settings_null_time');return null}
    check(rule.kind==='wall_clock' && Number.isInteger(rule.offsetMinutes) && Math.abs(rule.offsetMinutes)<=840,'settings_time_offset')
    const wall=inspectWallClock(raw).canonicalWallClock
    const date=new Date(Date.parse(wall.replace(' ','T')+'Z')-rule.offsetMinutes*60000)
    check(date.getUTCFullYear()>=1000 && date.getUTCFullYear()<=9999,'settings_time_range')
    return date.toISOString().replace('T',' ').slice(0,-1)
  }
  const entries=rows.map(row=>{
    const resolution=resolutions.get(row.id), sourceHash=hash(row)
    check(resolution?.sourceHash===sourceHash,'settings_basis_binding')
    const inspection=inspectSettingValue(row.category,row.key,row.value)
    check(inspection.compatible,'settings_value_unresolved')
    exactKeys(resolution.valueEvidence,['evidenceId','evidenceSha256','requirements'])
    evidence(resolution.valueEvidence)
    check(Array.isArray(resolution.valueEvidence.requirements)
      && JSON.stringify([...resolution.valueEvidence.requirements].sort())===JSON.stringify([...new Set(['semantic_review',...inspection.needs])].sort()),'settings_semantic_scope')
    const target={id:row.id,namespace:row.category,setting_key:row.key,value_type:inspection.type,value_text:row.value,
      sensitivity:inspection.exposure,label:row.label,sort_order:row.sort_order,
      created_at_utc:time(row.created_at,resolution.createdAt),updated_at_utc:time(row.updated_at,resolution.updatedAt),revision:'1',
      origin:'legacy_import',migration_run_id:run.id,source_sha256:sourceHash,imported_at_utc:imported}
    return {sourceId:row.id,sourceHash,target,targetHash:hash(target),provenance:{source:row,basisHash:hash(basis),resolution:structuredClone(resolution)}}
  })
  return {version:'settings-rows/v1',sourceHash:hash(rows),entries,transformHash:hash(entries),valuesDecrypted:false,
    evidenceCatalogExternallyRequired:true,consumersSwitched:false,fullSettingsConverted:false}
}
