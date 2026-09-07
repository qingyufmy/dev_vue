import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { recoveryLearningDefinitionHash } from '../scripts/lib/learning-completion-recovery-rendering.mjs'
import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'
import { loadLearningCompletionCoordinator } from '../scripts/lib/inplace-learning-completion-schema.mjs'
import { learningVerificationPool } from '../scripts/lib/mysql-learning-verification-v2.mjs'

const root = new URL('../', import.meta.url)
describe('learning completion schema gate', () => {
  it('allows historical locking reads but blocks mutations in the compatibility verifier', async () => {
    const calls = []
    const connection = await learningVerificationPool({ getConnection: async () => ({ execute: async sql => calls.push(sql) }) }).getConnection()
    await connection.execute('SELECT id FROM data_migration_runs FOR UPDATE')
    for (const sql of ['UPDATE users SET role=1','DELETE FROM progress','INSERT INTO data_migration_runs VALUES (1)','ALTER TABLE learning_progress ADD x INT']) {
      expect(() => connection.execute(sql)).toThrow('learning_verify_write_forbidden')
    }
    expect(calls).toHaveLength(1)
  })
  it('appends two checksum-bound transitions to the existing 62 steps', async () => {
    const plan = await loadLearningCompletionCoordinator(root)
    expect(plan.steps).toHaveLength(64)
    expect(plan.steps.at(-1).beforeHash).toBe(plan.steps.at(-2).afterHash)
    expect(plan.steps.at(-1).sql).toBe('ALTER TABLE learning_progress_changes\n  MODIFY request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL')
  })
  it('accepts only the four reviewed recovery regex renderings, never live drift or changed constraints', async () => {
    const proof = JSON.parse(await readFile(new URL('docs/migration/dev-vue-learning-schema-probe-20260907.json', root)))
    for (const { table, ddl } of proof.definitions) {
      const recovered = ddl.replace("regexp_like(`source_sha256`,_utf8mb4'[^0-9a-f]',_utf8mb4'c')", "regexp_like(`source_sha256`,_ascii'[^0-9a-f]',_utf8mb4'c')")
      expect(recoveryLearningDefinitionHash('dev_vue_m1_source_20260907_02', table, recovered)).toBe(tableDefinitionHash(ddl))
      expect(recoveryLearningDefinitionHash('dev_vue', table, recovered)).toBe(tableDefinitionHash(recovered))
      const changed = recovered.replace("[^0-9a-f]", "[^0-9a-fA-F]")
      expect(recoveryLearningDefinitionHash('dev_vue_m1_source_20260907_02', table, changed)).toBe(tableDefinitionHash(changed))
    }
  })
})
