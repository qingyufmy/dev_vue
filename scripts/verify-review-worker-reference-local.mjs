import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { Queue, Worker, QueueEvents } from 'bullmq'
import { parse } from 'dotenv'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { createMysqlReviewRecovery, createMysqlReviewWorker } from '../server/dist-v4/modules/reviews/composition.js'
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600), name = 'dev_vue_review_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'review-worker-mysql-reference/v1', passed: false, existingDatabaseWrites: 0, foreignKeysVerified: false, modelCalls: 'synthetic-only', checks: [] }
let db, pool, recoveryQueue, recoveryWorker, recoveryEvents, created = false
const recoveryPrefix = 'review-reference-' + randomUUID()
try {
  const input = []; for await (const chunk of process.stdin) input.push(chunk)
  const credential = JSON.parse(Buffer.concat(input).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  db = await mysql.createConnection({ ...credential, database: 'dev_vue', timezone: 'Z' })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  const definitions = []
  for (const table of ['review_cases_v4', 'review_jobs_v4', 'review_evidence_payloads_v4', 'strategies', 'strategy_versions', 'review_versions_v4',
    'review_version_payloads_v4', 'review_user_states_v4', 'review_model_attempts_v4', 'review_job_events_v4', 'outbox_events', 'review_case_sources_v4']) {
    const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`')
    definitions.push(row['Create Table'].split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)'))
  }
  await db.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  await db.query('USE `' + name + '`')
  for (const ddl of definitions) await db.query(ddl)
  pool = mysql.createPool({ ...credential, database: name, timezone: 'Z', connectionLimit: 3 })
  const hash = createHash('sha256').update('{}').digest('hex'), now = new Date(), time = now.toISOString().slice(0, 23).replace('T', ' ')
  const end = new Date(now.getTime() + 1000).toISOString().slice(0, 23).replace('T', ' ')
  const wire = { schema_version: 'review.v4.1', conclusion: 'mixed', headline: 'Reference', summary: 'Reference evidence',
    metrics: { net_profit: '0', trade_count: 0, win_rate_percent: null, profit_factor: null }, trade_episodes: [],
    roles: Object.fromEntries(['analyst','trader','risk','execution'].map(role => [role, { assessment: 'effective', summary: 'Reference', evidence_refs: [] }])),
    counterexamples: [], memory_candidates: [], evidence_refs: [], full_analysis_text: 'Reference output' }
  const seed = async (n, status = 'queued', archived = false) => {
    const caseId = 'case-' + n, jobId = 'job-' + n
    await db.execute("INSERT INTO review_cases_v4 (id,user_id,trading_account_id,kind,scope_key,terminal_period_start_utc,terminal_period_end_utc,terminal_timezone_offset_minutes,status,evidence_status,evidence_revision,evidence_sha256,legacy_source_table,created_at_utc,updated_at_utc) VALUES (?,1,1,'manual',?,?,?,180,?,'complete',1,?,?,?,?)", [caseId, caseId, time, end, archived ? 'archived' : 'queued', hash, archived ? 'manual_trade_review_cases' : null, time, time])
    await db.execute('INSERT INTO review_evidence_payloads_v4 VALUES (?,1,JSON_OBJECT(),?,2,?)', [caseId, hash, time])
    await db.execute("INSERT INTO review_jobs_v4 (id,review_case_id,generation,mode,status,evidence_revision,input_sha256,current_stage,created_at_utc,updated_at_utc) VALUES (?,?,1,'initial',?,1,?,'queued',?,?)", [jobId, caseId, status, hash, time, time])
    return jobId
  }
  let calls = 0
  const gateway = { profileId: '1', provider: 'reference', model: 'reference', timeoutMs: 1000, maxAttempts: 3,
    async invoke() { calls++; return { value: wire, usage: null } } }
  const resolver = { async resolve(claim) {
    const [[row]] = await db.execute('SELECT status FROM review_jobs_v4 WHERE id=?', [claim.jobId])
    assert.equal(row.status, 'waiting_model'); return gateway
  } }
  const worker = createMysqlReviewWorker(pool, resolver, 'worker-one')
  assert.equal((await worker.process(await seed(1))).status, 'succeeded')
  const [[complete]] = await db.query("SELECT j.status,c.status case_status FROM review_jobs_v4 j JOIN review_cases_v4 c ON c.id=j.review_case_id WHERE j.id='job-1'")
  assert.deepEqual({ ...complete }, { status: 'succeeded', case_status: 'awaiting_confirmation' }); report.checks.push('claim-and-complete-use-schema-compatible-status')
  const held = await seed(2, 'waiting_model')
  await db.execute("UPDATE review_jobs_v4 SET lease_owner='held',lease_expires_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?", [held])
  const previous = calls; assert.equal((await worker.process(held)).status, 'ignored'); assert.equal(calls, previous); report.checks.push('unexpired-lease-not-stolen')
  const expired = await seed(3, 'waiting_model')
  await db.execute("UPDATE review_jobs_v4 SET lease_owner='expired',lease_expires_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?", [expired])
  await db.execute("INSERT INTO review_model_attempts_v4 (id,review_job_id,attempt_number,model_profile_id,provider,model,status,started_at_utc) VALUES ('old-attempt',?,1,1,'reference','reference','running',?)", [expired, time])
  assert.equal((await worker.process(expired)).status, 'succeeded')
  const [[attempt]] = await db.query("SELECT status FROM review_model_attempts_v4 WHERE id='old-attempt'"); assert.equal(attempt.status, 'timed_out'); report.checks.push('expired-lease-reclaimed-and-attempt-expired')
  const racing = await seed(4)
  let release, ready
  const started = new Promise(resolve => { ready = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const old = createMysqlReviewWorker(pool, { async resolve() { ready(); await blocked; return gateway } }, 'old-worker')
  const pending = old.process(racing); const rejected = assert.rejects(pending, error => error.code === 'review_job_claim_stale')
  await started
  await db.execute('UPDATE review_jobs_v4 SET lease_expires_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?', [racing])
  assert.equal((await worker.process(racing)).status, 'succeeded'); release(); await rejected
  const [[count]] = await db.query("SELECT COUNT(*) n FROM review_versions_v4 WHERE review_case_id='case-4'"); assert.equal(Number(count.n), 1); report.checks.push('stale-worker-cannot-write-after-takeover')
  const archived = await seed(5, 'queued', true)
  const before = calls; assert.equal((await worker.process(archived)).status, 'ignored'); assert.equal(calls, before); report.checks.push('archived-case-never-calls-model')
  for (const [n, status] of [[6, 'retry_wait'], [7, 'queued']]) {
    const deferred = await seed(n, status)
    await db.execute('UPDATE review_jobs_v4 SET next_attempt_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?', [deferred])
    const [[prior]] = await db.execute('SELECT * FROM review_jobs_v4 WHERE id=?', [deferred])
    const modelBefore = calls
    assert.equal((await worker.process(deferred)).status, 'ignored'); assert.equal(calls, modelBefore)
    const [[after]] = await db.execute('SELECT * FROM review_jobs_v4 WHERE id=?', [deferred])
    assert.deepEqual(after, prior)
    const [[effects]] = await db.execute(`SELECT
      (SELECT COUNT(*) FROM review_model_attempts_v4 WHERE review_job_id=?) attempts,
      (SELECT COUNT(*) FROM review_job_events_v4 WHERE review_job_id=?) events,
      (SELECT status FROM review_cases_v4 WHERE id=?) case_status`, [deferred, deferred, 'case-' + n])
    assert.equal(Number(effects.attempts), 0); assert.equal(Number(effects.events), 0); assert.equal(effects.case_status, 'queued')
    await db.execute('UPDATE review_jobs_v4 SET next_attempt_at_utc=? WHERE id=?', [time, deferred])
    assert.equal((await worker.process(deferred, now)).status, 'succeeded')
    const [[done]] = await db.execute('SELECT next_attempt_at_utc FROM review_jobs_v4 WHERE id=?', [deferred])
    assert.equal(done.next_attempt_at_utc, null)
    report.checks.push(status + '-not-claimed-before-due-and-accepted-at-boundary')
  }
  const due = await seed(8, 'retry_wait')
  const crashed = await seed(9, 'validating')
  const future = await seed(10, 'retry_wait')
  await db.execute('UPDATE review_jobs_v4 SET next_attempt_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE id=?', [future])
  await db.execute('UPDATE review_jobs_v4 SET lease_expires_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?', [crashed])
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  const redisKey = env.QUEUE_REDIS_HOST ? 'QUEUE_REDIS' : 'REDIS'
  assert.equal(env[redisKey + '_HOST'], '192.168.1.254')
  report.redisConfigurationSource = redisKey
  report.runtimeQueueConfigurationVerified = redisKey === 'QUEUE_REDIS'
  const connection = { host: env[redisKey + '_HOST'], port: Number(env[redisKey + '_PORT'] || 6379),
    db: Number(env[redisKey + '_DB'] || 0), ...(env[redisKey + '_PASSWORD'] ? { password: env[redisKey + '_PASSWORD'] } : {}),
    maxRetriesPerRequest: null, connectTimeout: 5000, retryStrategy: times => times < 3 ? 100 : null }
  recoveryQueue = new Queue('review-reference', { connection, prefix: recoveryPrefix })
  recoveryEvents = new QueueEvents('review-reference', { connection, prefix: recoveryPrefix })
  recoveryQueue.on('error', () => {}); recoveryEvents.on('error', () => {})
  await recoveryQueue.waitUntilReady(); await recoveryEvents.waitUntilReady()
  const recovery = createMysqlReviewRecovery(pool, recoveryQueue)
  await recovery.tick(); await recovery.tick()
  const queued = await recoveryQueue.getJobs(['waiting', 'prioritized'])
  assert.deepEqual(queued.map(job => job.data.reviewJobId).sort(), [due, crashed].sort())
  const completions = queued.map(job => job.waitUntilFinished(recoveryEvents, 15000))
  recoveryWorker = new Worker('review-reference', async job => {
    assert.equal(job.name, 'review.run')
    return worker.process(job.data.reviewJobId)
  }, { connection, prefix: recoveryPrefix, concurrency: 2 })
  recoveryWorker.on('error', () => {})
  const results = await Promise.all(completions)
  assert.ok(results.every(result => result.status === 'succeeded'))
  report.recoveryResults = results
  await recovery.tick()
  const counts = await recoveryQueue.getJobCounts('waiting', 'prioritized', 'active', 'completed', 'failed')
  assert.ok(Object.values(counts).every(count => count === 0))
  // A previously ignored wake must not permanently suppress recovery under the same fencing token.
  await recoveryWorker.pause()
  const id = 'recovery-replay'
  await recoveryQueue.add('review.run', { reviewJobId: 'missing-reference-job' }, { jobId: id, removeOnComplete: true })
  const ignored = await recoveryQueue.getJob(id)
  const ignoredDone = ignored.waitUntilFinished(recoveryEvents, 15000)
  await recoveryWorker.resume(); assert.equal((await ignoredDone).status, 'ignored')
  await recoveryWorker.pause()
  await recoveryQueue.add('review.run', { reviewJobId: 'missing-reference-job' }, { jobId: id, removeOnComplete: true })
  const replayed = await recoveryQueue.getJob(id)
  assert.ok(replayed)
  const replayedDone = replayed.waitUntilFinished(recoveryEvents, 15000)
  await recoveryWorker.resume(); assert.equal((await replayedDone).status, 'ignored')
  report.checks.push('completed-ignored-wake-can-be-enqueued-again-with-same-id')
  await recovery.stop()
  report.checks.push('real-redis-repeated-scans-deduplicate-and-complete-due-and-expired-jobs')
  report.redisVerified = true
  const tampered = await seed(11)
  await db.execute("UPDATE review_evidence_payloads_v4 SET evidence_json=JSON_OBJECT('injected','not-frozen') WHERE review_case_id='case-11'")
  const callsBeforeTamper = calls
  await assert.rejects(worker.process(tampered), { code: 'review_job_evidence_hash_mismatch' })
  assert.equal(calls, callsBeforeTamper)
  const [[unchanged]] = await db.execute("SELECT status,fencing_token,attempt_count FROM review_jobs_v4 WHERE id=?", [tampered])
  assert.equal(unchanged.status, 'queued'); assert.equal(Number(unchanged.fencing_token), 0); assert.equal(Number(unchanged.attempt_count), 0)
  const [[effects]] = await db.execute("SELECT (SELECT COUNT(*) FROM review_model_attempts_v4 WHERE review_job_id=?) attempts,(SELECT COUNT(*) FROM review_job_events_v4 WHERE review_job_id=?) events", [tampered,tampered])
  assert.equal(Number(effects.attempts), 0); assert.equal(Number(effects.events), 0)
  report.checks.push('tampered-evidence-rejected-before-model-or-claim-state-writes')
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3); process.exitCode = 1 }
finally {
  if (recoveryWorker) await recoveryWorker.close()
  if (recoveryEvents) await recoveryEvents.close()
  if (recoveryQueue) {
    assert.match(recoveryPrefix, /^review-reference-[a-f0-9-]{36}$/)
    await recoveryQueue.obliterate({ force: true }); await recoveryQueue.close(); report.referenceQueueRemoved = true
  }
  if (pool) await pool.end()
  if (db) { if (created) { assert.match(name, /^dev_vue_review_ref_[a-f0-9]{32}$/); await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } await db.end() }
  report.observedAt = new Date().toISOString(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); console.log(JSON.stringify(report))
}
