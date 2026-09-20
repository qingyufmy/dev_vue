import {verifyQuoteUpgradeCoordinator} from './quote-upgrade-coordinator-reference.mjs'
import assert from 'node:assert/strict'
import { randomUUID,createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { MysqlTradingRepository } from '../../server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js'
import { createMysqlQuoteProvenanceWriter,assertMysqlQuoteProvenanceCapability } from '../../server/dist-v4/modules/trading/composition.js'

export async function verifyQuoteProvenanceReference(pool) {
  const db=await pool.getConnection(), name='dev_vue_quote_ref_'+randomUUID().replaceAll('-',''), checks=[]
  let created=false,original
  try {
    const [[identity]]=await db.query('SELECT DATABASE() db');original=identity.db
    assert.match(original,/^dev_vue_strategy_ref_[a-f0-9]{32}$/);assert.match(name,/^dev_vue_quote_ref_[a-f0-9]{32}$/)
    await db.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;await db.query(`USE ${name}`)
    for(const ddl of [
      'CREATE TABLE users (id INT PRIMARY KEY) ENGINE=InnoDB',
      'CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB',
      'CREATE TABLE terminal_profiles (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY) ENGINE=InnoDB',
      'CREATE TABLE trading_account_ownership_intervals (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY) ENGINE=InnoDB',
      `CREATE TABLE trading_projection_revisions (trading_account_id BIGINT UNSIGNED NOT NULL,resource_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,revision BIGINT UNSIGNED NOT NULL,updated_at_utc DATETIME(3),PRIMARY KEY(trading_account_id,resource_kind,resource_id),FOREIGN KEY(trading_account_id) REFERENCES trading_accounts(id)) ENGINE=InnoDB`,
      `CREATE TABLE market_quotes (trading_account_id BIGINT UNSIGNED NOT NULL,symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,bid DECIMAL(47,18),ask DECIMAL(47,18),last_price DECIMAL(47,18),spread DECIMAL(47,18),trade_mode VARCHAR(32),observed_at_utc DATETIME(3),revision BIGINT,PRIMARY KEY(trading_account_id,symbol)) ENGINE=InnoDB`,
    ])await db.query(ddl)
    const legacy=await readFile(new URL('../../server/db/migrations/20260905_020_account_projection_and_history_provenance.sql',import.meta.url),'utf8')
    await db.query(splitSqlStatements(legacy)[0])
    await db.query('INSERT INTO users VALUES (7)');await db.query('INSERT INTO trading_accounts VALUES (5)')
    await db.query("INSERT INTO terminal_profiles VALUES ('profile')");await db.query("INSERT INTO trading_account_ownership_intervals VALUES ('interval')")
    for(const kind of ['account.metrics','positions','pending_orders']) {
      await db.execute('INSERT INTO trading_projection_revisions VALUES (5,?,?,1,UTC_TIMESTAMP(3))',[kind,'old'])
      await db.execute("INSERT INTO trading_projection_provenance_v4 VALUES (5,?,'old',7,'interval',1,'profile','terminal',1,1,'2026-09-10 10:00:00.123')",[kind])
    }
    const rows=async()=>JSON.stringify((await db.query('SELECT * FROM trading_projection_provenance_v4 ORDER BY resource_kind,resource_id'))[0])
    const before=await rows(),[[beforeDdl]]=await db.query('SHOW CREATE TABLE trading_projection_provenance_v4')
    await db.beginTransaction()
    try {
      await db.query("INSERT INTO trading_projection_revisions VALUES (5,'market.quote','XAUUSD',1,UTC_TIMESTAMP(3))")
      await assert.rejects(()=>db.query("INSERT INTO trading_projection_provenance_v4 VALUES (5,'market.quote','XAUUSD',7,'interval',1,'profile','terminal',1,1,UTC_TIMESTAMP(3))"),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED')
    } finally {await db.rollback()}

    const route={accountId:'5',userId:7,terminalProfileId:'profile',terminalInstanceId:'terminal',connectionEpoch:1,connectionId:'connection',installationId:'installation',credentialGeneration:1,ownershipRevision:'1'}
    const projection={accountId:'5',resource:'market.quote',resourceId:'XAUUSD',revision:2,data:{accountId:'5',symbol:'XAUUSD',bid:'2500',ask:'2500.1',last:null,spread:'0.1',tradeMode:'full',observedAt:'2026-09-10T10:00:00.123Z',revision:2}}
    let injectFailure=false
    // Only route authorization SELECTs are injected. All projection/CAS/provenance SQL and transaction operations are real.
    const connection={
      execute:async(sql,params=[])=>{
        if(sql.startsWith('SELECT id FROM trading_accounts WHERE id='))return [[{id:'5'}],[]]
        if(sql.includes('SELECT o.interval_id'))return [[{interval_id:'interval',ownership_revision:1}],[]]
        if(sql.includes('FROM bridge_refresh_sessions s')&&sql.includes('s.credential_version=4'))return [[{id:1}],[]]
        if(sql.includes('SELECT b.terminal_profile_id'))return [[{terminal_profile_id:'profile'}],[]]
        if(sql.includes('SELECT s.id'))return [[{id:1}],[]]
        const result=await db.execute(sql,params)
        if(injectFailure&&sql.includes('INSERT INTO trading_projection_provenance_v4'))throw Error('injected_source_after_write')
        return result
      },
      beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>{},
    }
    const repository=new MysqlTradingRepository({getConnection:async()=>connection},null,undefined,undefined,createMysqlQuoteProvenanceWriter)
    await assert.rejects(()=>repository.applyTrustedProjection({route,projection}),error=>error.code==='quote_provenance_schema_not_ready')
    assert.equal(Number((await db.query('SELECT COUNT(*) n FROM market_quotes'))[0][0].n),0)
    assert.equal(await rows(),before);checks.push('old-schema-rejects-source-capability-and-rolls-back-quote-and-revision')
    const migration=await readFile(new URL('../../server/db/migrations/inplace/057_market_quote_provenance.sql',import.meta.url),'utf8')
    const statements=splitSqlStatements(migration);assert.equal(statements.length,1)
    const upgrade=await verifyQuoteUpgradeCoordinator(db)
    try {await assertMysqlQuoteProvenanceCapability(db)}
    catch(error) {
      const [[constraint]]=await db.query("SELECT CHECK_CLAUSE clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_projection_provenance_kind'")
      error.referenceStatement=constraint?.clause;throw error
    }
    assert.equal(await rows(),before)
    const [[afterDdl]]=await db.query('SHOW CREATE TABLE trading_projection_provenance_v4')
    checks.push('single-alter-preserves-all-three-existing-source-kinds-and-foreign-keys')
    injectFailure=true;await assert.rejects(()=>repository.applyTrustedProjection({route,projection}),/injected_source_after_write/)
    assert.equal(Number((await db.query('SELECT COUNT(*) n FROM market_quotes'))[0][0].n),0);assert.equal(await rows(),before)
    assert.equal(Number((await db.query("SELECT COUNT(*) n FROM trading_projection_revisions WHERE resource_kind='market.quote'"))[0][0].n),0)
    checks.push('real-parent-quote-revision-and-source-all-rollback-after-source-insert')
    injectFailure=false;assert.equal((await repository.applyTrustedProjection({route,projection})).applied,true)
    const [[proof]]=await db.query("SELECT *,DATE_FORMAT(observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed FROM trading_projection_provenance_v4 WHERE resource_kind='market.quote'")
    assert.equal(proof.resource_id,'XAUUSD');assert.equal(Number(proof.connection_epoch),1);assert.equal(Number(proof.projection_revision),2);assert.equal(proof.observed,'2026-09-10T10:00:00.123000Z')
    const saved=await rows();assert.equal((await repository.applyTrustedProjection({route,projection})).applied,false);assert.equal(await rows(),saved)
    checks.push('actual-repository-quote-and-source-commit-with-exact-milliseconds-repeated-revision-no-write')
    await db.query("INSERT INTO trading_projection_revisions VALUES (5,'other','XAUUSD',2,UTC_TIMESTAMP(3))")
    await assert.rejects(()=>db.query("UPDATE trading_projection_provenance_v4 SET resource_kind='other' WHERE resource_kind='market.quote'"),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED')
    await assert.rejects(()=>db.query("UPDATE trading_projection_provenance_v4 SET user_id=8 WHERE resource_kind='market.quote'"),error=>error.code==='ER_NO_REFERENCED_ROW_2')
    checks.push('unsupported-kind-and-invalid-source-user-still-rejected')
    return {passed:true,checks,upgrade,migrationSha256:createHash('sha256').update(migration).digest('hex'),beforeDdl:beforeDdl['Create Table'],afterDdl:afterDdl['Create Table'],authorization:'injected-route-selects',existingDatabaseWrites:0,referenceDatabaseRemoved:true}
  } finally {
    await db.rollback()
    if(original)await db.query(`USE ${original}`)
    if(created)await db.query(`DROP DATABASE ${name}`)
    db.release()
  }
}
