import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements, validateMigrationStatement } from './v4-migration-plan.mjs'

// Source registration only. Promotion into the inplace coordinator requires a
// real reference schema proof; never synthesize SHOW CREATE hashes offline.
export async function loadBridgeInstallationSource(root) {
  const path = 'server/db/migrations/inplace/080_bridge_installation_authorizations.sql'
  const bytes = await readFile(new URL(path, root))
  const bootstrap = await readFile(new URL('server/db/migrations/20260914_028_bridge_installation_authorizations.sql', root))
  assert.deepEqual(bytes, bootstrap)
  const statements = splitSqlStatements(bytes.toString('utf8'))
  assert.equal(statements.length, 4)
  for (const statement of statements) validateMigrationStatement(statement, '20260914_028_bridge_installation_authorizations')
  return { protocol: 'bridge-installation-authorizations/v1', sources: [{ path, sha256: sha256(bytes) }], statements,
    promotionStatus: 'reference_database_proof_required' }
}
