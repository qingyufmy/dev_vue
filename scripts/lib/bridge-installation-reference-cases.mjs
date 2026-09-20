import { createHash, randomBytes } from 'node:crypto'

const referenceName = /^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) throw new Error(`bridge_reference_${code}`) }
const identifier = value => {
  check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(value), 'column_identifier_invalid')
  return `\`${value}\``
}

/**
 * Synthetic DML only, against a reference database already created/migrated by the caller.
 * No connection creation, migrations, USE statement, terminal traffic, or business database access.
 * Every connection (including repository transactions) is checked before it is handed over.
 * The caller owns reference database disposal; this helper never deletes databases or fixtures.
 */
export async function runBridgeInstallationReferenceCases(pool, repositoryClass) {
  check(pool && typeof pool.getConnection === 'function', 'pool_required')
  check(typeof repositoryClass === 'function', 'repository_class_required')
  let database, stage = 'database_guard', injectCommitAckLoss = false
  const counters = { checkedConnections: 0, syntheticUsers: 0, expectedConflicts: 0, storageRetries: 0,
    committedAckLosses: 0, discardedConnections: 0 }
  const tag = randomBytes(16).toString('hex'), keyPrefix = `biref:${tag}:`
  const secrets = new Set(), fixtures = []

  const connection = async () => {
    const client = await pool.getConnection()
    try {
      const [rows] = await client.query('SELECT DATABASE() AS reference_database')
      const selected = rows[0]?.reference_database
      check(typeof selected === 'string' && referenceName.test(selected), 'database_name_rejected')
      check(database === undefined || database === selected, 'pooled_database_changed')
      database = selected
      counters.checkedConnections++
    } catch (error) { client.release(); throw error }
    return new Proxy(client, {
      get(target, property) {
        if (property === 'commit') return async () => {
          await target.commit()
          if (injectCommitAckLoss) {
            injectCommitAckLoss = false
            counters.committedAckLosses++
            throw new Error('injected_reference_commit_ack_lost')
          }
        }
        if (property === 'destroy') return () => { counters.discardedConnections++; return target.destroy() }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const scoped = {
    getConnection: connection,
    async execute(sql, values = []) {
      const client = await connection()
      try { return await client.execute(sql, values) } finally { client.release() }
    },
    async query(sql, values = []) {
      const client = await connection()
      try { return await client.query(sql, values) } finally { client.release() }
    },
  }
  const repo = new repositoryClass(scoped)
  const key = suffix => `${keyPrefix}${suffix}`
  const secret = (prefix, length) => { const value = prefix + randomBytes(length).toString('base64url'); secrets.add(value); return value }
  const expectError = async (work, code, status) => {
    let caught
    try { await work() } catch (error) { caught = error }
    check(caught?.code === code && caught?.status === status, `expected_${code}`)
    counters.expectedConflicts++
  }
  const retryStorage = async work => {
    for (let attempt = 0; ; attempt++) {
      try { return await work() } catch (error) {
        if (error?.status !== 503 || attempt === 2) throw error
        counters.storageRetries++
      }
    }
  }
  const createInput = (label, installationId = `biref-${tag}-${label}`) => {
    const input = { installation_id: installationId, device_name: `reference-${label}`,
      poll_secret_hash: digest(secret('bip_', 32)), installation_token_hash: digest(secret('bi4_', 48)), request_key: key(label) }
    const fixture = { input, ipHash: digest(`reference-ip-${tag}-${label}`), id: undefined }
    fixtures.push(fixture)
    return fixture
  }
  const start = async fixture => {
    const result = await repo.start(fixture.input, fixture.ipHash)
    check(typeof result.authorization_id === 'string', 'start_id_missing')
    check(result.confirmation_path === `/bridge/authorize?request=${result.authorization_id}`, 'confirmation_path_invalid')
    fixture.id = result.authorization_id
    return result
  }
  const expire = fixture => {
    check(typeof fixture.id === 'string', 'fixture_id_missing')
    return scoped.execute('UPDATE bridge_installation_requests SET expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 DAY,next_poll_at_utc=NULL WHERE id=? AND request_key=?',
      [fixture.id, fixture.input.request_key])
  }
  const approve = async (fixture, user, suffix = 'approval') => {
    const before = await repo.confirmation(fixture.id, user)
    const decisionKey = key(`${suffix}-${fixture.id}`)
    const result = await repo.decide(fixture.id, user, decisionKey, 'approved', before.revision)
    check(result.status === 'approved', 'approval_not_durable')
    return { decisionKey, revision: before.revision, result }
  }
  const count = async (sql, params) => {
    const [rows] = await scoped.execute(sql, params)
    return Number(rows[0]?.n)
  }
  const commitLost = async work => {
    check(!injectCommitAckLoss, 'ack_injection_already_armed')
    const before = counters.committedAckLosses
    injectCommitAckLoss = true
    await expectError(work, 'bridge_installation_commit_unknown', 503)
    check(!injectCommitAckLoss && counters.committedAckLosses === before + 1, 'real_commit_not_observed')
  }

  try {
    // No writes occur before this explicit guard, nor on subsequently borrowed unverified connections.
    const verified = await connection(); verified.release()
    stage = 'seed_synthetic_users'
    const users = await seedEligibleUsers(scoped, tag)
    counters.syntheticUsers = users.length

    stage = 'start_recovery_conflict'
    const primary = createInput('primary')
    const first = await start(primary), replay = await start(primary)
    check(first.authorization_id === replay.authorization_id, 'start_replay_created_request')
    await expectError(() => repo.start({ ...primary.input, device_name: 'different-reference-device' }, primary.ipHash),
      'bridge_installation_request_conflict', 409)
    check(await count('SELECT COUNT(*) n FROM bridge_installation_requests WHERE request_key=?', [primary.input.request_key]) === 1,
      'start_duplicate_rows')

    stage = 'approval_late_poll'
    const approved = await approve(primary, users[0])
    await expire(primary)
    const late = await repo.poll(primary.id, primary.input.poll_secret_hash, primary.input.installation_token_hash)
    check(late.status === 'approved' && late.authorized === true && late.user.id === String(users[0]), 'late_approval_not_recoverable')
    const repeatedDecision = await repo.decide(primary.id, users[0], approved.decisionKey, 'approved', approved.revision)
    check(repeatedDecision.revision === approved.result.revision, 'decision_replay_advanced_revision')

    stage = 'denied_and_expired'
    const denied = createInput('denied'); await start(denied)
    const denial = await repo.confirmation(denied.id, users[0])
    await repo.decide(denied.id, users[0], key('deny'), 'denied', denial.revision)
    await expire(denied)
    check((await repo.poll(denied.id, denied.input.poll_secret_hash, denied.input.installation_token_hash)).status === 'denied', 'denial_reclassified')
    const expired = createInput('expired'); await start(expired); await expire(expired)
    const expiredView = await repo.confirmation(expired.id, users[0])
    await expectError(() => repo.decide(expired.id, users[0], key('expired-approval'), 'approved', expiredView.revision),
      'bridge_installation_expired', 410)
    check((await repo.poll(expired.id, expired.input.poll_secret_hash, expired.input.installation_token_hash)).status === 'expired', 'expired_poll_invalid')
    check(await count('SELECT COUNT(*) n FROM bridge_installation_authorizations WHERE id IN (?,?)', [denied.id, expired.id]) === 0,
      'unapproved_request_authorized')

    stage = 'double_approval_single_winner'
    const double = createInput('double'); await start(double)
    const revision = (await repo.confirmation(double.id, users[0])).revision
    const doubleResults = await Promise.allSettled([0, 1].map(index =>
      retryStorage(() => repo.decide(double.id, users[0], key(`double-${index}`), 'approved', revision))))
    check(doubleResults.filter(value => value.status === 'fulfilled').length === 1, 'double_approval_winner_count')
    check(doubleResults.some(value => value.status === 'rejected' && value.reason?.code === 'bridge_installation_decision_conflict'), 'double_approval_loser_not_conflict')
    check(await count('SELECT COUNT(*) n FROM bridge_installation_authorizations WHERE id=?', [double.id]) === 1, 'double_approval_duplicate_identity')

    stage = 'cross_user_installation_race'
    const installation = `biref-${tag}-shared`
    const contenders = [createInput('cross-one', installation), createInput('cross-two', installation)]
    await Promise.all(contenders.map(start))
    const crossResults = await Promise.allSettled(contenders.map(async (fixture, index) => {
      const current = await repo.confirmation(fixture.id, users[index])
      // A MySQL deadlock can surface as storage_failed. Replay the exact decision after rollback.
      return retryStorage(() => repo.decide(fixture.id, users[index], key(`cross-decision-${index}`), 'approved', current.revision))
    }))
    check(crossResults.filter(value => value.status === 'fulfilled').length === 1, 'cross_user_winner_count')
    check(crossResults.some(value => value.status === 'rejected' && value.reason?.code === 'bridge_installation_identity_conflict'), 'cross_user_loser_not_conflict')
    const [crossRows] = await scoped.execute('SELECT id,user_id FROM bridge_installation_authorizations WHERE installation_id=? AND revoked_at_utc IS NULL', [installation])
    const winner = crossResults.findIndex(value => value.status === 'fulfilled')
    check(crossRows.length === 1 && crossRows[0].id === contenders[winner].id && Number(crossRows[0].user_id) === users[winner], 'cross_user_identity_misbound')

    stage = 'concurrent_profile_idempotency'
    const refreshHash = digest(secret('br4_', 48)), profileKey = key('profile-concurrent')
    const profileCall = () => repo.registerProfile(primary.input.installation_id, primary.input.installation_token_hash, profileKey, refreshHash)
    const profileResults = await Promise.all([retryStorage(profileCall), retryStorage(profileCall)])
    check(profileResults[0].profile_id === profileResults[1].profile_id, 'concurrent_profile_duplicate')
    const independent = await repo.registerProfile(primary.input.installation_id, primary.input.installation_token_hash,
      key('profile-independent'), digest(secret('br4_', 48)))
    check(independent.profile_id !== profileResults[0].profile_id, 'separate_profiles_share_id')
    check(await count('SELECT COUNT(*) n FROM bridge_refresh_sessions WHERE installation_authorization_id=? AND installation_request_key=?',
      [primary.id, profileKey]) === 1, 'concurrent_profile_duplicate_rows')
    check(await count('SELECT COUNT(DISTINCT token_hash) n FROM bridge_refresh_sessions WHERE installation_authorization_id=?', [primary.id]) === 2,
      'independent_profile_credentials_shared')
    await expectError(() => repo.registerProfile(primary.input.installation_id, primary.input.installation_token_hash, profileKey, digest(secret('br4_', 48))),
      'bridge_installation_profile_conflict', 409)

    stage = 'revoke_registration_race'
    const race = createInput('revoke-race'); await start(race); await approve(race, users[1])
    await repo.registerProfile(race.input.installation_id, race.input.installation_token_hash, key('race-existing'), digest(secret('br4_', 48)))
    const racingHash = digest(secret('br4_', 48))
    const raced = await Promise.allSettled([
      retryStorage(() => repo.registerProfile(race.input.installation_id, race.input.installation_token_hash, key('race-new'), racingHash)),
      retryStorage(() => repo.revoke(race.input.installation_id, race.input.installation_token_hash)),
    ])
    check(raced[1].status === 'fulfilled', 'racing_revoke_failed')
    check(raced[0].status === 'fulfilled' || raced[0].reason?.code === 'bridge_installation_credential_invalid', 'racing_registration_unexpected_result')
    check(await count('SELECT COUNT(*) n FROM bridge_installation_authorizations WHERE id=? AND revoked_at_utc IS NOT NULL', [race.id]) === 1,
      'racing_parent_still_active')
    check(await count('SELECT COUNT(*) n FROM bridge_refresh_sessions WHERE installation_authorization_id=? AND revoked_at IS NULL', [race.id]) === 0,
      'racing_child_survived_revocation')
    await expectError(() => repo.authenticate(race.input.installation_id, race.input.installation_token_hash), 'bridge_installation_credential_invalid', 401)

    stage = 'committed_ack_loss_recovery'
    const unknown = createInput('ack-lost')
    await commitLost(() => repo.start(unknown.input, unknown.ipHash))
    const [committedRequests] = await scoped.execute('SELECT id FROM bridge_installation_requests WHERE request_key=?', [unknown.input.request_key])
    check(committedRequests.length === 1, 'unknown_start_not_committed')
    await start(unknown)
    check(unknown.id === committedRequests[0].id, 'unknown_start_replaced')
    const unknownRevision = (await repo.confirmation(unknown.id, users[0])).revision
    const decisionCall = () => repo.decide(unknown.id, users[0], key('ack-decision'), 'approved', unknownRevision)
    await commitLost(decisionCall)
    check((await decisionCall()).status === 'approved', 'unknown_decision_not_recovered')
    check(await count('SELECT COUNT(*) n FROM bridge_installation_authorizations WHERE id=?', [unknown.id]) === 1, 'unknown_decision_duplicated')
    const unknownHash = digest(secret('br4_', 48)), unknownKey = key('ack-profile')
    const registrationCall = () => repo.registerProfile(unknown.input.installation_id, unknown.input.installation_token_hash, unknownKey, unknownHash)
    await commitLost(registrationCall)
    const [committedProfiles] = await scoped.execute('SELECT profile_id FROM bridge_refresh_sessions WHERE installation_authorization_id=? AND installation_request_key=?', [unknown.id, unknownKey])
    check(committedProfiles.length === 1, 'unknown_profile_not_committed')
    check((await registrationCall()).profile_id === committedProfiles[0].profile_id, 'unknown_profile_replaced')
    const revokeCall = () => repo.revoke(unknown.input.installation_id, unknown.input.installation_token_hash)
    await commitLost(revokeCall); await revokeCall()
    check(await count('SELECT COUNT(*) n FROM bridge_refresh_sessions WHERE installation_authorization_id=? AND revoked_at IS NULL', [unknown.id]) === 0,
      'unknown_revoke_not_durable')
    check(counters.committedAckLosses === 4 && counters.discardedConnections >= 4, 'unknown_connections_not_discarded')

    stage = 'plaintext_absence'
    const requestKeys = fixtures.map(fixture => fixture.input.request_key)
    const placeholders = requestKeys.map(() => '?').join(',')
    const projection = async (table, alias) => {
      const [columns] = await scoped.execute('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
      check(columns.length > 0, 'credential_projection_missing')
      return columns.map(row => `${alias}.${identifier(row.COLUMN_NAME)}`).join(',')
    }
    const [requests] = await scoped.execute(`SELECT ${await projection('bridge_installation_requests', 'r')} FROM bridge_installation_requests r WHERE r.request_key IN (${placeholders})`, requestKeys)
    check(requests.length === fixtures.length, 'fixture_request_count')
    const [identities] = await scoped.execute(`SELECT ${await projection('bridge_installation_authorizations', 'i')} FROM bridge_installation_authorizations i INNER JOIN bridge_installation_requests r ON r.id=i.id WHERE r.request_key IN (${placeholders})`, requestKeys)
    const [children] = await scoped.execute(`SELECT ${await projection('bridge_refresh_sessions', 'p')} FROM bridge_refresh_sessions p INNER JOIN bridge_installation_requests r ON r.id=p.installation_authorization_id WHERE r.request_key IN (${placeholders})`, requestKeys)
    const persisted = JSON.stringify([requests, identities, children])
    for (const plain of secrets) check(!persisted.includes(plain), 'plaintext_credential_persisted')
    const expectedHashes = new Set([...secrets].map(digest))
    check(requests.every(row => expectedHashes.has(row.poll_secret_hash) && expectedHashes.has(row.installation_token_hash)), 'request_hash_unexpected')
    check(identities.every(row => expectedHashes.has(row.token_hash)) && children.every(row => expectedHashes.has(row.token_hash)), 'credential_hash_unexpected')

    return { passed: true, isolatedDatabaseVerified: true, syntheticUsersOnly: true,
      startReplayAndConflict: true, approvedLatePoll: true, deniedAndExpired: true,
      doubleApprovalSingleWinner: true, crossUserInstallationSingleWinner: true,
      concurrentProfileIdempotency: true, independentProfileCredentials: true,
      revokeRegistrationRaceClosed: true, committedAckLossRecovery: true, noPlaintextCredentials: true,
      counts: { ...counters, requests: requests.length, authorizations: identities.length, profiles: children.length },
      businessDatabaseWrites: 0, realTerminalUsed: false }
  } catch (error) {
    injectCommitAckLoss = false
    // Never emit database messages, statements, parameters, or synthetic credential values.
    if (typeof error?.message === 'string' && /^bridge_reference_[a-z0-9_]+$/.test(error.message)) throw error
    throw new Error(`bridge_reference_case_failed_${stage}`)
  }
}

async function seedEligibleUsers(pool, tag) {
  const [columns] = await pool.execute(`SELECT COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,
    CHARACTER_MAXIMUM_LENGTH,GENERATION_EXPRESSION FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' ORDER BY ORDINAL_POSITION`)
  const names = new Set(columns.map(column => column.COLUMN_NAME))
  for (const required of ['id', 'role', 'plan', 'plan_expires_at', 'deletion_status', 'deleted_at', 'nickname'])
    check(names.has(required), 'users_schema_missing_required_field')
  const ids = []
  for (let index = 0; index < 2; index++) {
    const values = new Map()
    for (const column of columns) {
      if (/auto_increment/i.test(column.EXTRA ?? '') || column.GENERATION_EXPRESSION) continue
      if (column.IS_NULLABLE === 'YES' || column.COLUMN_DEFAULT !== null) continue
      values.set(column.COLUMN_NAME, syntheticColumnValue(column, tag, index))
    }
    for (const [name, value] of Object.entries({ role: 'admin', plan: 'pro', plan_expires_at: null,
      deletion_status: 'active', deleted_at: null, nickname: `reference-${tag.slice(0, 12)}-${index}` })) values.set(name, value)
    if (names.has('uid')) values.set('uid', `${tag.slice(0, 28)}${index}`)
    if (names.has('email')) values.set('email', `biref-${tag}-${index}@example.invalid`)
    const idColumn = columns.find(column => column.COLUMN_NAME === 'id')
    if (!/auto_increment/i.test(idColumn.EXTRA ?? '')) {
      const [maximum] = await pool.execute('SELECT COALESCE(MAX(id),0) AS max_id FROM users')
      values.set('id', Number(maximum[0].max_id) + 1)
    }
    const [result] = await pool.execute(`INSERT INTO users (${[...values.keys()].map(identifier).join(',')}) VALUES (${[...values].map(() => '?').join(',')})`, [...values.values()])
    const id = Number(values.get('id') ?? result.insertId)
    check(Number.isSafeInteger(id) && id > 0, 'synthetic_user_id_invalid')
    ids.push(id)
  }
  return ids
}

function syntheticColumnValue(column, tag, index) {
  const type = column.DATA_TYPE.toLowerCase(), name = column.COLUMN_NAME
  if (type === 'enum') {
    const first = /^enum\('((?:[^'\\]|\\.)*)'/.exec(column.COLUMN_TYPE)
    check(Boolean(first), 'users_enum_unsupported')
    return first[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }
  if (type === 'set') return ''
  if (['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'bit'].includes(type)) return index + 1
  if (['date', 'datetime', 'timestamp'].includes(type)) return type === 'date' ? '2026-09-14' : '2026-09-14 00:00:00.000'
  if (type === 'time') return '00:00:00'
  if (type === 'year') return 2026
  if (type === 'json') return '{}'
  const size = Number(column.CHARACTER_MAXIMUM_LENGTH ?? 255)
  if (['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext'].includes(type))
    return `ref${index}-${digest(`${tag}:${name}:${index}`)}`.slice(0, Math.min(size, 80))
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(type))
    return Buffer.from(digest(`${tag}:${name}:${index}`)).subarray(0, Math.min(size, 32))
  throw new Error('bridge_reference_users_required_column_unsupported')
}
