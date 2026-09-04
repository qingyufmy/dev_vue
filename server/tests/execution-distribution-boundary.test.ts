import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Stage 12N user command and distribution persistence boundary', () => {
  it('adds only append-only command, frozen target and outcome structures', async () => {
    const migration = await readFile(new URL('../db/migrations/20260904_011_user_execution_commands_and_distributions.sql', import.meta.url), 'utf8')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS user_execution_commands')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS execution_distributions')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS execution_distribution_targets')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS execution_outcomes')
    expect(migration).toContain('source_outcome_id')
    expect(migration).toContain('source_ticket')
    expect(migration).toContain('frozen_context_json')
    expect(migration).toContain('result_summary_json')
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM|UPDATE\s+(?:users|trading_accounts|strategy_subscriptions)\b/i)
  })

  it('keeps AI source links intact while allowing exactly one non-AI source family', async () => {
    const migration = await readFile(new URL('../db/migrations/20260904_011_user_execution_commands_and_distributions.sql', import.meta.url), 'utf8')
    expect(migration).toContain('MODIFY COLUMN risk_decision_id')
    expect(migration).toContain('MODIFY COLUMN trade_decision_id')
    expect(migration).toContain('ADD COLUMN user_command_id')
    expect(migration).toContain('chk_execution_intent_source_family')
    expect(migration).toContain("source_type='risk_decision'")
    expect(migration).toContain("source_type<>'risk_decision'")
  })

  it('persists terminal outcome evidence without changing the no-replay Bridge boundary', async () => {
    const repository = await readFile(new URL('../src/modules/execution/infrastructure/mysql-bridge-command-repository.ts', import.meta.url), 'utf8')
    expect(repository).toContain('persistExecutionOutcome')
    expect(repository).toContain('INSERT INTO execution_outcomes')
    expect(repository).toContain("status === 'uncertain'")
    expect(repository).not.toMatch(/retry\s*\(.*command|replay\s*\(.*command|OrderSend/i)
    expect(repository).toContain('refreshDistributionTargetFromChild')
    expect(repository).toContain("status === 'uncertain'")
  })

  it('dispatches each frozen account target independently through the shared command path', async () => {
    const repository = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-distribution-repository.ts', import.meta.url), 'utf8')
    const worker = await readFile(new URL('../src/modules/execution/application/execution-distribution-worker.ts', import.meta.url), 'utf8')
    expect(repository).toContain("'execution.distribution.target.requested'")
    expect(repository).toContain('distribution_target_id: target.id')
    expect(worker).toContain('this.commands.execute(command, now)')
    expect(worker).toContain('dist-target:')
  })

  it('binds the damaged frozen-target rejection update to exactly its three placeholders', async () => {
    const repository = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-distribution-repository.ts', import.meta.url), 'utf8')
    expect(repository).toContain("completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [now, row.id, row.revision]")
    expect(repository).not.toContain("completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [now, now, row.id, row.revision]")
  })

  it('keeps read-only distribution preview off the target-freeze lock path', async () => {
    const repository = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-distribution-repository.ts', import.meta.url), 'utf8')
    expect(repository).toContain('queryEligibleTargets(this.pool, input.strategyId, strategy.versionId, input.symbol, false)')
    expect(repository).toContain("const lockClause = lock ? ' FOR UPDATE' : ''")
    expect(repository).toContain('ready: candidate.tradePermission && missingResources.length === 0')
  })
})
