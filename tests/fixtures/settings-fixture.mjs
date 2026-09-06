import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
import { prepareSettingsRows } from '../../scripts/lib/v4-settings-rows.mjs'
export function settingsFixture() {
  const row={id:'1',category:'smtp',key:'secure',value:'false',label:'安全连接',sort_order:null,created_at:'2026-01-01 01:00:00',updated_at:null}
  const proof={evidenceId:'synthetic',evidenceSha256:'a'.repeat(64)}
  const options={run:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sourceSnapshotId:'synthetic',registeredAtUtc:'2026-09-07T00:00:00.000Z'},evidenceCatalog:new Map([['synthetic',proof.evidenceSha256]]),
    basis:{version:'settings-import/v1',sourceHash:hash([row]),sourceSnapshotId:'synthetic',resolutions:[{sourceId:'1',sourceHash:hash(row),
      createdAt:{raw:row.created_at,kind:'wall_clock',offsetMinutes:480,...proof},updatedAt:{raw:null,kind:'source_null',offsetMinutes:null,...proof},valueEvidence:{...proof,requirements:['semantic_review']}}]}}
  return {row,options,convert(){return prepareSettingsRows([this.row],this.options)}}
}
