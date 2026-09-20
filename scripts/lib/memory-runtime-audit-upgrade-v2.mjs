import { readFile } from 'node:fs/promises'
import { loadMemoryRuntimeAuditUpgrade } from './memory-runtime-audit-upgrade.mjs'

/** Parent existence or an observed legacy hash cannot admit a V4 snapshot foreign key. */
export function assertMemorySnapshotParent(table) {
  const columns=new Map((table?.columns??[]).map(column=>[column.name,column]))
  const expected={id:['char(36)','ascii_bin','NO'],purpose:["enum('analysis','trader')",null,'NO'],payload_sha256:['char(64)','ascii_bin','NO']}
  if(!table?.exists || columns.size!==(table.columns??[]).length)throw Error('memory_audit_v4_snapshot_parent_required')
  for(const [name,[type,collation,nullable]]of Object.entries(expected)){
    const column=columns.get(name)
    if(!column || column.type!==type || column.nullable!==nullable || (collation!==null && column.collation!==collation)
      || (name==='id' && column.columnKey!=='PRI'))throw Error('memory_audit_v4_snapshot_parent_required')
  }
}
/** Supersedes v1 admission. Does not mutate its frozen plan or failed rehearsal evidence. */
export async function loadMemoryRuntimeAuditUpgradeV2(root) {
  const inventory=JSON.parse(await readFile(new URL('docs/architecture/inference-schema-current-inventory-20260910.json',root),'utf8'))
  if(!inventory.passed || inventory.writes!==0 || inventory.target!=='dev_vue')throw Error('memory_audit_parent_inventory_invalid')
  assertMemorySnapshotParent(inventory.tables.inference_snapshots)
  return loadMemoryRuntimeAuditUpgrade(root)
}
