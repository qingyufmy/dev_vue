import assert from 'node:assert/strict'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'
import { createStrategyRoleWriter } from './mysql-strategy-role-writer.mjs'

// DDL reference validation only, not the production backfill writer.
export async function verifyStrategyRoleIdentityReference(connection) {
  const [[database]] = await connection.query('SELECT DATABASE() name')
  assert.match(database.name, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
  await connection.beginTransaction()
  try {
    const roles = []
    const strategySql = `INSERT INTO strategies
      (kind,scope,name,description,status,legacy_source_table,legacy_id,created_at_utc,updated_at_utc)
      VALUES (?,'platform','identity reference','','draft',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`
    const versionSql = `INSERT INTO strategy_versions
      (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,
       config_json,created_by_user_id,legacy_source_table,legacy_id,created_at_utc)
      VALUES (?,44,?,?,?,?,?,7,?,?,UTC_TIMESTAMP(3))`
    for (const kind of ['analysis', 'trader']) {
      const identity = strategyRoleLegacyIdentity('9007199254740993', '44', kind)
      const compiled = compileStrategy(kind, 'identity reference', {})
      assert.equal(compiled.valid, true)
      const strategyArgs = [kind, identity.strategy.legacySourceTable, identity.strategy.legacyId]
      const [inserted] = await connection.execute(strategySql, strategyArgs)
      const strategyId = String(inserted.insertId)
      const versionArgs = [strategyId, 'identity reference', compiled.promptHash, compiled.inputContractVersion,
        compiled.outputContractVersion, JSON.stringify(compiled.normalizedConfig), identity.version.legacySourceTable, identity.version.legacyId]
      const [version] = await connection.execute(versionSql, versionArgs)
      const versionId = String(version.insertId)
      await connection.execute('UPDATE strategies SET active_version_id=? WHERE id=?', [versionId, strategyId])
      await assert.rejects(connection.execute(strategySql, strategyArgs), { code: 'ER_DUP_ENTRY' })
      // Change version number to isolate the legacy-key constraint from the
      // independent (strategy_id, version_number) unique index.
      await assert.rejects(connection.execute(versionSql.replace('VALUES (?,44,', 'VALUES (?,45,'), versionArgs), { code: 'ER_DUP_ENTRY' })
      roles.push({ strategyId, versionId, identity })
    }
    await assert.rejects(connection.execute('UPDATE strategies SET active_version_id=? WHERE id=?',
      [roles[0].versionId, roles[1].strategyId]), { code: 'ER_NO_REFERENCED_ROW_2' })
    const [rows] = await connection.execute(`SELECT s.kind,s.legacy_id strategyLegacyId,v.legacy_id versionLegacyId,
      v.version_number versionNumber FROM strategies s JOIN strategy_versions v ON v.id=s.active_version_id AND v.strategy_id=s.id
      WHERE s.legacy_source_table=? AND s.legacy_id IN (?,?) ORDER BY s.kind`,
    ['auto_prompt_types', ...roles.map(row => row.identity.strategy.legacyId)])
    assert.equal(rows.length, 2)
    for (const row of rows) {
      const expected = roles.find(role => role.identity.strategy.legacyId === row.strategyLegacyId)
      assert.ok(expected)
      assert.equal(row.versionLegacyId, expected.identity.version.legacyId)
      assert.equal(row.versionNumber, 44)
    }
    const projections = ['analysis', 'trader'].map((kind, index) => {
      const identity = strategyRoleLegacyIdentity('11', '44', kind)
      const compiled = compileStrategy(kind, 'backfill reference', {})
      const strategyId = String(10001 + index), versionId = String(20001 + index)
      const time = '2026-09-09 00:00:00.123'
      return { strategy: { id: strategyId, kind, scope: 'platform', owner_user_id: null, name: 'backfill reference', description: '',
        status: 'draft', active_version_id: versionId, revision: '1', legacy_source_table: identity.strategy.legacySourceTable,
        legacy_id: identity.strategy.legacyId, created_at_utc: time, updated_at_utc: time, deleted_at_utc: null },
      version: { id: versionId, strategy_id: strategyId, version_number: '44', prompt_text: 'backfill reference',
        prompt_sha256: compiled.promptHash, input_contract_version: compiled.inputContractVersion, output_contract_version: compiled.outputContractVersion,
        config_json: compiled.normalizedConfig, created_by_user_id: '7', legacy_source_table: identity.version.legacySourceTable,
        legacy_id: identity.version.legacyId, created_at_utc: time } }
    })
    const writer = createStrategyRoleWriter(projections)
    for (const projection of projections) {
      await assert.rejects(writer.write(connection, projection, { verifyOnly: true }), { code: 'strategy_role_writer_not_committed' })
      assert.equal((await writer.write(connection, projection)).inserted, 2)
      assert.equal((await writer.write(connection, projection)).inserted, 0)
      assert.equal((await writer.write(connection, projection, { verifyOnly: true })).inserted, 0)
      const changed = structuredClone(projection); changed.version.prompt_text = 'changed'
      await assert.rejects(writer.write(connection, changed), { code: 'strategy_role_writer_input_changed' })
      await connection.execute('UPDATE strategy_versions SET prompt_text=? WHERE id=?', ['conflict', projection.version.id])
      await assert.rejects(writer.write(connection, projection), { code: 'strategy_role_writer_target_conflict' })
      const [[saved]] = await connection.execute('SELECT prompt_text FROM strategy_versions WHERE id=?', [projection.version.id])
      assert.equal(saved.prompt_text, 'conflict')
    }
    return { roleCount: rows.length, duplicateStrategyRejected: true, duplicateVersionLegacyKeyRejected: true,
      crossRoleActiveVersionRejected: true, largeSourceIdPreserved: true,
      projectionWriter: { roles: projections.length, replayInserted: 0, verifyOnlyChecked: true, changedInputRejected: true, existingConflictPreserved: true } }
  } finally { await connection.rollback() }
}
