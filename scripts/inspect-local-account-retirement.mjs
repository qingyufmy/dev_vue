import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'

const [userPath, ownedPath, observerPath, journalPath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 7 && [userPath, ownedPath, observerPath, journalPath, destination].every(isAbsolute))
const user = JSON.parse(await readFile(userPath, 'utf8'))
const owned = JSON.parse(await readFile(ownedPath, 'utf8'))
const observer = JSON.parse(await readFile(observerPath, 'utf8'))
const intent = JSON.parse((await readFile(journalPath, 'utf8')).split('\n')[0])
assert.equal(user.kind, 'local-account-fixture/v1')
assert.equal(owned.kind, 'local-owned-accounts-intent/v1')
assert.equal(observer.kind, 'local-observer-fixture/v1'); assert.equal(observer.passed, true)
assert.equal(intent.kind, 'local-observer-fixture-intent/v1')
assert.equal(owned.userId, user.userId); assert.equal(observer.viewerUserId, user.userId)
assert.match(user.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.match(owned.brokerServer, /^V4-LOCAL-[a-f0-9-]{36}$/)
assert.equal(intent.actorEmail, `v4-local-observer-${intent.runId}@example.invalid`)
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
try {
  connection = await pool.getConnection()
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const [users] = await connection.execute('SELECT id FROM users WHERE (id=? AND email=?) OR (id=? AND uid=? AND email=?)',
    [user.userId, user.email, observer.actorUserId, intent.runId.replaceAll('-', ''), intent.actorEmail])
  assert.equal(users.length, 2)
  const [accounts] = await connection.execute(`SELECT CAST(a.id AS CHAR) id,CAST(a.ownership_revision AS CHAR) revision,
    o.user_id userId,o.interval_id intervalId,CAST(o.revision AS CHAR) grantRevision,o.revoked_at_utc revokedAt,
    oi.ended_at_utc endedAt,oi.origin_kind originKind,oi.origin_ref originRef
    FROM trading_accounts a JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.role='owner'
    JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id
    WHERE (a.broker_server=? AND a.account_login IN (?,?) AND o.user_id=?)
      OR (a.id=? AND a.broker_server=? AND a.account_login=? AND o.user_id=?) ORDER BY a.id`,
  [owned.brokerServer, ...owned.logins, user.userId, observer.accountId, intent.brokerServer, intent.login, observer.actorUserId])
  assert.equal(accounts.length, 3)
  for (const row of accounts) {
    assert.equal(row.originKind, 'runtime'); assert.equal(row.originRef, `bridge-first-account:${row.id}`)
    assert.equal(row.revokedAt, null); assert.equal(row.endedAt, null); assert.equal(row.revision, row.grantRevision)
  }
  const [references] = await connection.execute(`SELECT TABLE_NAME tableName,COLUMN_NAME columnName,CONSTRAINT_NAME constraintName
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE()
      AND REFERENCED_TABLE_NAME='trading_accounts' AND REFERENCED_COLUMN_NAME='id'
    ORDER BY TABLE_NAME,COLUMN_NAME,CONSTRAINT_NAME LIMIT 501`)
  assert.ok(references.length < 501)
  const ids = accounts.map(row => row.id)
  const counts = []
  for (const reference of references) {
    assert.match(reference.tableName, /^[a-zA-Z0-9_]+$/); assert.match(reference.columnName, /^[a-zA-Z0-9_]+$/)
    const [rows] = await connection.execute(`SELECT CAST(\`${reference.columnName}\` AS CHAR) accountId,COUNT(*) count
      FROM \`${reference.tableName}\` WHERE \`${reference.columnName}\` IN (?,?,?) GROUP BY \`${reference.columnName}\``, ids)
    counts.push({ ...reference, rows })
  }
  const [contexts] = await connection.execute('SELECT user_id userId,mode,CAST(trading_account_id AS CHAR) accountId,revision FROM trading_contexts WHERE trading_account_id IN (?,?,?)', ids)
  const report = { kind: 'local-account-retirement-preflight/v1', observedAt: new Date().toISOString(), identity, accounts, references: counts, contexts,
    mutationAuthorizedByReport: false,
    limitations: ['Foreign keys do not enumerate SQL-only, JSON, Redis or external references.', 'Counts include history and do not decide deletion safety.', 'No complete account ownership retirement application capability exists yet; do not update ownership or delete accounts from this report.'],
    scope: 'Read-only consistent snapshot of exact synthetic accounts and declared foreign-key references; preserve all rows.' }
  await connection.rollback()
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ accounts: ids, foreignKeys: counts.length, nonemptyReferences: counts.filter(row => row.rows.length), contexts }))
} finally { if (connection) { try { await connection.rollback() } finally { connection.release() } } await pool.end() }
