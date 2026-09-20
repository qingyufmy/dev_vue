import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertMemorySnapshotParent, loadMemoryRuntimeAuditUpgradeV2 } from './memory-runtime-audit-upgrade-v2.mjs'
const compatible=()=>({exists:true,columns:[
  {name:'id',type:'char(36)',nullable:'NO',collation:'ascii_bin',columnKey:'PRI'},
  {name:'purpose',type:"enum('analysis','trader')",nullable:'NO'},
  {name:'payload_sha256',type:'char(64)',nullable:'NO',collation:'ascii_bin'}]})
test('rejects the actual current legacy parent before exposing an upgrade plan',async()=>{
  await assert.rejects(loadMemoryRuntimeAuditUpgradeV2(new URL('../../',import.meta.url)),/memory_audit_v4_snapshot_parent_required/)
})
for(const field of ['type','collation','columnKey'])test(`rejects incompatible snapshot identity ${field}`,()=>{
  const t=compatible();t.columns[0][field]='wrong'
  assert.throws(()=>assertMemorySnapshotParent(t),/memory_audit_v4_snapshot_parent_required/)
})
test('rejects missing V4 payload metadata even if the primary key shape matches',()=>{
  const t=compatible();t.columns.pop();assert.throws(()=>assertMemorySnapshotParent(t),/memory_audit_v4_snapshot_parent_required/)
})
test('accepts the required parent column shape without claiming full schema readiness',()=>{
  assert.doesNotThrow(()=>assertMemorySnapshotParent(compatible()))
})
