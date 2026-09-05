import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, sha256 } from '../scripts/lib/v4-migration-plan.mjs'
import { loadMigrationCorrections } from '../scripts/lib/v4-migration-corrections.mjs'

const rootDirectory = process.cwd()
const correctionFile = 'server/db/migrations/corrections/011-execution-intent-foreign-keys.sql'
const migrationId = '20260904_011_user_execution_commands_and_distributions'

describe('V4 migration corrections', () => {
  it('loads one immutable correction bound to the reviewed original file and statement', async () => {
    const plan = await loadMigrationPlan({ rootDirectory })
    const [correction] = await loadMigrationCorrections({ rootDirectory }, plan)

    expect(correction).toMatchObject({
      id: '011-execution-intent-foreign-keys',
      migrationId,
      statementNumber: 3,
      originalChecksum: '59f39b04871bee1a470785f03d3a7de1719c39a4abe22e87c16a2a8d3dc0ca3f',
      originalStatementChecksum: 'e2d3d71be9dfd1db4703345e929eef8421e162179e8a4adabab72ee318c08250',
      checksum: '747c209d9dfe75ad969cf04e4b037d7b1e1dc6838565bf63c2db20de4dea419b',
      sqlChecksum: 'c307519eb07ac064382c7ee372a8e63aa51b578d5589bec2b91384beca8ec7e9',
    })
    expect(correction.sql).toContain('ADD CONSTRAINT fk_execution_intent_risk_v4 FOREIGN KEY')
    expect(correction.sql).toContain('ADD CONSTRAINT fk_execution_intent_trade_v4 FOREIGN KEY')
    expect(correction.sql).not.toContain('ADD CONSTRAINT fk_execution_intent_risk FOREIGN KEY')
    expect(correction.sql).not.toContain('ADD CONSTRAINT fk_execution_intent_trade FOREIGN KEY')
    expect(Object.isFrozen(correction)).toBe(true)
  })

  it('changes only the two foreign-key names from original statement 3', async () => {
    const plan = await loadMigrationPlan({ rootDirectory })
    const original = plan.find(migration => migration.id === migrationId).statements[2]
    const [correction] = await loadMigrationCorrections({ rootDirectory }, plan)
    const equivalent = correction.sql
      .replace('fk_execution_intent_risk_v4', 'fk_execution_intent_risk')
      .replace('fk_execution_intent_trade_v4', 'fk_execution_intent_trade')

    expect(equivalent).toBe(original)
    expect(sha256(correction.sql)).toBe('c307519eb07ac064382c7ee372a8e63aa51b578d5589bec2b91384beca8ec7e9')
  })

  it('rejects a plan whose original migration file checksum no longer matches', async () => {
    const plan = await loadMigrationPlan({ rootDirectory })
    const altered = plan.map(migration => migration.id === migrationId
      ? { ...migration, checksum: '0'.repeat(64) }
      : migration)

    await expect(loadMigrationCorrections({ rootDirectory }, altered))
      .rejects.toThrow('migration_correction_original_checksum_mismatch')
  })

  it('rejects a plan whose original statement 3 checksum no longer matches', async () => {
    const plan = await loadMigrationPlan({ rootDirectory })
    const altered = plan.map(migration => migration.id === migrationId
      ? { ...migration, statements: migration.statements.map((statement, index) => index === 2 ? `${statement} ` : statement) }
      : migration)

    await expect(loadMigrationCorrections({ rootDirectory }, altered))
      .rejects.toThrow('migration_correction_original_statement_checksum_mismatch')
  })

  it('rejects any correction file modification before it can be applied', async () => {
    const plan = await loadMigrationPlan({ rootDirectory })
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'aurum-v4-correction-'))
    const temporaryFile = join(temporaryRoot, correctionFile)
    try {
      await mkdir(dirname(temporaryFile), { recursive: true })
      await copyFile(join(rootDirectory, correctionFile), temporaryFile)
      await writeFile(temporaryFile, `${await readFile(temporaryFile, 'utf8')} `)

      await expect(loadMigrationCorrections({ rootDirectory: temporaryRoot }, plan))
        .rejects.toThrow('migration_correction_checksum_mismatch')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
