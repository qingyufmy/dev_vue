import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'

const target = 'dev_vue_m1_source_20260907_02'
const identityMatch = 'BINARY LOWER(TRIM(a.broker_server))=BINARY LOWER(TRIM(s.broker_server)) AND BINARY a.account_login=BINARY CAST(s.account_login AS CHAR)'
const queries = {
  sources: `SELECT CAST(s.id AS CHAR) sourceId,
    (SELECT COUNT(*) FROM market_candles c WHERE c.source_id=s.id) candleRows,
    (SELECT COUNT(*) FROM trading_accounts a WHERE ${identityMatch}) identityCandidates,
    (SELECT COUNT(DISTINCT a.id) FROM trading_accounts a INNER JOIN trading_account_ownership_intervals i
      ON i.trading_account_id=a.id AND i.user_id=s.bridge_user_id AND i.role='owner' WHERE ${identityMatch}) historicalOwnerCandidates
    FROM market_data_sources s ORDER BY s.id`,
  summary: `SELECT COUNT(*) candleRows,COUNT(DISTINCT c.source_id) sourceCount,
    SUM(s.id IS NULL) orphanRows,SUM(c.standard_symbol='') emptyStandardSymbols,
    SUM(c.timeframe NOT IN ('M1','M5','M15','M30','H1','H4','D1')) unsupportedTimeframes,
    MIN(c.open_time_utc_msc) minUtcMilliseconds,MAX(c.open_time_utc_msc) maxUtcMilliseconds
    FROM market_candles c LEFT JOIN market_data_sources s ON s.id=c.source_id`,
  collisions: `SELECT COUNT(*) collisionGroups,COALESCE(SUM(g.n),0) collisionRows,
    COALESCE(SUM(g.payloadVariants>1),0) divergentGroups,
    COALESCE(SUM(IF(g.payloadVariants>1,g.n,0)),0) divergentRows,
    COALESCE(SUM(g.sourceVariants>1),0) crossSourceGroups FROM (
    SELECT COUNT(*) n,COUNT(DISTINCT c.source_id) sourceVariants,
      COUNT(DISTINCT BINARY CONCAT_WS('|',CAST(c.open_price AS CHAR),CAST(c.high_price AS CHAR),
        CAST(c.low_price AS CHAR),CAST(c.close_price AS CHAR),CAST(c.tick_volume AS CHAR))) payloadVariants
    FROM market_candles c INNER JOIN market_data_sources s ON s.id=c.source_id
    INNER JOIN trading_accounts a ON ${identityMatch}
    WHERE (SELECT COUNT(*) FROM trading_accounts a WHERE ${identityMatch})=1
    GROUP BY a.id,BINARY c.standard_symbol,c.timeframe,c.open_time_utc_msc HAVING COUNT(*)>1) g`,
}
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  assert.equal(mode, '--read-only-restored'); assert.ok(process.argv.length === 4 && isAbsolute(destination))
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await connection.query('SET TRANSACTION READ ONLY')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
  const results = {}
  for (const [name, sql] of Object.entries(queries)) { const [rows] = await connection.query(sql); results[name] = rows }
  await connection.rollback()
  const receipt = { kind: 'legacy-candle-mapping-probe/v1', observedAt: new Date().toISOString(), identity,
    queryHashes: Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, hash(sql)])), results,
    databaseWrites: 0, interpretation: 'Candidate matches only: server/login without platform or interval-time proof is not an approved mapping. Collision grouping assumes standard_symbol and must be reviewed.' }
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(receipt))
} catch {
  console.error(JSON.stringify({ code: 'legacy_candle_mapping_probe_failed', target })); process.exitCode = 1
} finally { if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }; if (output) await output.close().catch(() => {}) }
