import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { buildStrategyRolePromptCandidate } from './lib/strategy-role-prompt-candidate.mjs'
import { legacyStrategyFields } from './lib/v4-strategy-source-review.mjs'
import { convertStrategyRoleConfig } from './lib/v4-strategy-role-config-conversion.mjs'
import { compileStrategy } from '../server/dist-v4/modules/strategies/application/strategy-service.js'
import { runLocalBackupProcess, discardLocalBackupOutput } from './lib/local-backup-process.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'

assert.equal(process.argv.length, 2)
const plan = JSON.parse(await readFile('docs/migration/atr-role-section-review-20260910.json', 'utf8'))
assert.equal(plan.sourceId, '3'); assert.equal(plan.sourceVersion, '11')
const directory = 'D:/dev_codex/.backup-core-20260910-01'
await runLocalBackupProcess({ command: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  args: ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/private-local-backup-directory.ps1'), '-Mode', 'Verify', '-Path', directory],
  consume: discardLocalBackupOutput, timeoutMs: 15000 })
const env = parse(await readFile('server/.env'))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
try {
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const [rows] = await connection.execute(`SELECT ${legacyStrategyFields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM auto_prompt_types WHERE id=? AND version=?`, [plan.sourceId, plan.sourceVersion])
  assert.equal(rows.length, 1)
  const source = { ...rows[0] }, candidate = buildStrategyRolePromptCandidate(source, plan)
  const config = convertStrategyRoleConfig(source)
  const compile = Object.fromEntries(['analysis', 'trader'].map(kind => [kind,
    compileStrategy(kind, candidate.roles[kind].promptText, config[`${kind}Config`])]))
  assert.ok(Object.values(compile).every(value => value.valid))
  await connection.rollback()
  const privatePath = join(directory, 'strategy-3-v11-role-candidate-v1.json')
  const output = await open(privatePath, 'wx', 0o600)
  try { await output.writeFile(JSON.stringify({ ...candidate, config, runtimeBlockers: plan.runtimeBlockers }, null, 2) + '\n') }
  finally { await output.close() }
  const report = { kind: candidate.kind, observedAt: new Date().toISOString(), sourceId: source.id, sourceVersion: source.version,
    sourceHash: candidate.sourceHash, sourcePromptHash: candidate.sourcePromptHash, planHash: hash(plan), privateArtifact: privatePath,
    roles: Object.fromEntries(Object.entries(candidate.roles).map(([kind, { promptText, ...metadata }]) => [kind, metadata])),
    sections: candidate.sections, originalTextFullyAssigned: candidate.originalTextFullyAssigned, compilePassed: true,
    runtimeBlockers: plan.runtimeBlockers, executable: false, semanticAcceptance: 'pending', databaseWrites: 0 }
  const publicOutput = await open('docs/architecture/atr-role-prompt-candidate-20260910.json', 'wx', 0o600)
  try { await publicOutput.writeFile(JSON.stringify(report, null, 2) + '\n') } finally { await publicOutput.close() }
  console.log(JSON.stringify({ sourceId: source.id, sourceVersion: source.version, sections: candidate.sections.length, compilePassed: true, executable: false, databaseWrites: 0 }))
} finally { await connection.end() }
