import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { loadColumnEvidence, originalDefinition, validateColumnEvidence } from '../scripts/lib/inplace-column-evidence.mjs'

const root = new URL('../', import.meta.url)
const paths = ['dev-vue-inplace-backup-20260906.json', 'dev-vue-inplace-column-rehearsal-20260906.json', 'dev-vue-inplace-rehearsal-tools-20260906.json']
  .map(name => new URL(`docs/migration/${name}`, root))
it('binds the real rehearsal to the current immutable SQL and execution core', async () => {
  const evidence = await loadColumnEvidence(root, paths)
  expect(evidence.backup.parity.tableCount).toBe(165)
})
it('rejects a rehearsal from another snapshot or with missing table coverage', async () => {
  const [backup, rehearsal] = await Promise.all(paths.slice(0, 2).map(async path => JSON.parse(await readFile(path, 'utf8'))))
  expect(() => validateColumnEvidence(backup, { ...rehearsal, backupSnapshotId: 'different' })).toThrow('inplace_rehearsal_receipt_invalid')
  expect(() => validateColumnEvidence(backup, { ...rehearsal, parity: rehearsal.parity.slice(1) })).toThrow('inplace_rehearsal_parity_invalid')
})
it('removes only verified additive column lines and preserves constraints and table options', () => {
  const base = 'CREATE TABLE `users` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=7'
  const added = base.replace('  PRIMARY', '  `profile_revision` bigint unsigned NOT NULL DEFAULT \'1\',\n  PRIMARY')
  expect(originalDefinition('users', added)).toBe(base)
  expect(originalDefinition('unrelated', added)).toBe(added)
  expect(originalDefinition('users', added.replace('AUTO_INCREMENT=7', 'AUTO_INCREMENT=8'))).not.toBe(base)
  expect(originalDefinition('users', added.replace('PRIMARY KEY (`id`)', 'PRIMARY KEY (`profile_revision`)'))).not.toBe(base)
})
