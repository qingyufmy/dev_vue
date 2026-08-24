import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))
vi.mock('../../server/db.js', () => db)

import {
  acquireModelTaskCapacity, modelTaskCapacityQueue,
  releaseModelTaskCapacityLease, retainModelTaskCapacityLease,
} from '../../server/routes/ai/model-task-capacity.js'

const defaultPolicy = {
  policy_scope:'default', model_profile_id:0, max_concurrency:4,
  reserve_execution_critical_slots:1, background_per_user_cap:1,
  lease_ms:120_000, conservative_lease_ms:300_000, waiter_poll_ms:5, starvation_age_ms:25,
}

const state = { waiters:[], leases:[], nextWaiterId:1, profilePolicies:new Map() }

function policyRows(profileId) {
  const profile = state.profilePolicies.get(Number(profileId || 0))
  return profile ? [defaultPolicy, { ...profile, policy_scope:'profile', model_profile_id:Number(profileId) }] : [defaultPolicy]
}

function profileFromParams(params = []) {
  const values = params.filter(value => value !== undefined)
  const numeric = values.map(Number).find(value => Number.isInteger(value) && value > 0)
  return numeric || null
}

async function runSql(sql, params = []) {
  const text = String(sql)
  if (text.includes('INSERT INTO ai_model_capacity_leases')) {
    const [leaseId, ownerToken, waiterId, modelTaskId, profileId, userId, usage, queue, acquiredAt, expiresAt] = params
    state.leases.push({ lease_id:leaseId, owner_token:ownerToken, waiter_id:waiterId,
      model_task_id:modelTaskId, model_profile_id:profileId, user_id:userId, usage,
      queue_class:queue, status:'active', acquired_at_utc_msc:acquiredAt,
      lease_expires_at_utc_msc:expiresAt })
    return [[], { affectedRows:1, insertId:0 }]
  }
  if (text.includes('UPDATE ai_model_capacity_leases') && text.includes("status = 'expired'")) {
    const now = Number(params.at(-1))
    for (const lease of state.leases) if (lease.status === 'active' && lease.lease_expires_at_utc_msc <= now) lease.status = 'expired'
    return [[], { affectedRows:1 }]
  }
  if (text.includes('UPDATE ai_model_capacity_waiters') && text.includes("status = 'expired'")) {
    const now = Number(params.at(-1))
    for (const waiter of state.waiters) if (waiter.status === 'waiting' && waiter.deadline_at_utc_msc <= now) waiter.status = 'expired'
    return [[], { affectedRows:1 }]
  }
  if (text.includes('UPDATE ai_model_capacity_waiters') && text.includes("status = 'cancelled'")) {
    const [, , waiterId, ownerToken] = params
    const row = state.waiters.find(item => item.waiter_id === Number(waiterId)
      && item.owner_token === ownerToken && item.status === 'waiting')
    if (row) row.status = 'cancelled'
    return [[], { affectedRows:row ? 1 : 0 }]
  }
  if (text.includes('UPDATE ai_model_capacity_waiters') && text.includes("status = 'granted'")) {
    const [leaseId, , , waiterId, ownerToken] = params
    const row = state.waiters.find(item => item.waiter_id === Number(waiterId)
      && item.owner_token === ownerToken && item.status === 'waiting')
    if (row) { row.status = 'granted'; row.lease_id = leaseId }
    return [[], { affectedRows:row ? 1 : 0 }]
  }
  if (text.includes('UPDATE ai_model_capacity_leases') && text.includes("status = 'released'")) {
    const [, , , leaseId, ownerToken] = params
    const row = state.leases.find(item => item.lease_id === leaseId && item.owner_token === ownerToken && item.status === 'active')
    if (row) row.status = 'released'
    return [[], { affectedRows:row ? 1 : 0 }]
  }
  if (text.includes('UPDATE ai_model_capacity_leases') && text.includes('conservative_until_utc_msc')) {
    const [, , , , leaseId, ownerToken] = params
    const row = state.leases.find(item => item.lease_id === leaseId && item.owner_token === ownerToken && item.status === 'active')
    if (row) row.lease_expires_at_utc_msc = Number(params[0])
    return [[], { affectedRows:row ? 1 : 0 }]
  }
  if (text.includes('UPDATE ai_model_capacity_leases') && text.includes('lease_expires_at_utc_msc = ?')) {
    const [expiresAt, , leaseId, ownerToken] = params
    const row = state.leases.find(item => item.lease_id === leaseId && item.owner_token === ownerToken && item.status === 'active')
    if (row) row.lease_expires_at_utc_msc = Number(expiresAt)
    return [[], { affectedRows:row ? 1 : 0 }]
  }
  if (text.includes('INSERT INTO ai_model_capacity_waiters')) {
    const [ownerToken, modelTaskId, profileId, userId, usage, queue, requestedAt, deadlineAt] = params
    state.waiters.push({ waiter_id:state.nextWaiterId++, owner_token:ownerToken,
      model_task_id:modelTaskId, model_profile_id:profileId, user_id:userId, usage,
      queue_class:queue, status:'waiting', requested_at_utc_msc:requestedAt,
      deadline_at_utc_msc:deadlineAt })
    return { insertId:state.waiters.at(-1).waiter_id, affectedRows:1 }
  }
  return [[], { affectedRows:1 }]
}

beforeEach(() => {
  state.waiters.length = 0
  state.leases.length = 0
  state.nextWaiterId = 1
  state.profilePolicies.clear()
  vi.clearAllMocks()
  db.queryAll.mockImplementation(async (_sql, params) => policyRows(profileFromParams(params)))
  db.queryRun.mockImplementation(async (sql, params) => {
    const result = await runSql(sql, params)
    return Array.isArray(result) ? result[1] : result
  })
  db.withTransaction.mockImplementation(async callback => callback(async (sql, params = []) => {
    const text = String(sql)
    if (text.includes('SELECT policy_scope')) return [policyRows(profileFromParams(params)), {}]
    if (text.includes('SELECT lease_id, queue_class')) {
      const now = Number(params[0])
      const profileId = Number(params[1]) || null
      return [state.leases.filter(lease => lease.status === 'active'
        && lease.lease_expires_at_utc_msc > now
        && (profileId ? Number(lease.model_profile_id) === profileId : lease.model_profile_id == null)), {}]
    }
    if (text.includes('SELECT waiter_id, owner_token')) {
      const profileId = Number(params[0]) || null
      return [state.waiters.filter(waiter => waiter.status === 'waiting'
        && (profileId ? Number(waiter.model_profile_id) === profileId : waiter.model_profile_id == null)), {}]
    }
    const result = await runSql(sql, params)
    return Array.isArray(result) ? result : [[], result]
  }))
})

const request = (usage, overrides = {}) => acquireModelTaskCapacity({
  profileId:1, userId:1, usage, modelTaskId:`task-${Math.random()}`,
  ...overrides,
}, { deadlineAtMs:Date.now() + 500, ...overrides.options })

describe('model-task capacity reservations', () => {
  it('maps automatic, interactive and background usage to the intended queues', () => {
    expect(modelTaskCapacityQueue('auto_platform')).toBe('execution_critical')
    expect(modelTaskCapacityQueue('auto_private')).toBe('execution_critical')
    expect(modelTaskCapacityQueue('manual')).toBe('interactive')
    expect(modelTaskCapacityQueue('model-test')).toBe('interactive')
    expect(modelTaskCapacityQueue('review')).toBe('background')
    expect(modelTaskCapacityQueue('model_compare')).toBe('background')
    expect(modelTaskCapacityQueue('memory_compression')).toBe('background')
    expect(modelTaskCapacityQueue('memory_consistency')).toBe('background')
    expect(() => modelTaskCapacityQueue('memory_consistncy')).toThrow('model_capacity_usage_unknown:memory_consistncy')
  })

  it('reserves one critical slot: a fourth background waits while critical work is admitted', async () => {
    const first = await request('review', { userId:1 })
    const second = await request('review', { userId:2 })
    const third = await request('review', { userId:3 })
    const controller = new AbortController()
    const blocked = request('review', { userId:4, options:{ signal:controller.signal } })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(state.waiters.some(row => row.status === 'waiting' && row.user_id === 4)).toBe(true)

    const critical = await request('auto_platform', { userId:9 })
    expect(state.leases.find(row => row.lease_id === critical.leaseId)).toMatchObject({ queue_class:'execution_critical' })
    controller.abort(new Error('test_capacity_abort'))
    await expect(blocked).rejects.toThrow('test_capacity_abort')
    await Promise.all([first.release('test'), second.release('test'), third.release('test'), critical.release('test')])
  })

  it('enforces one background lease per user but admits a different user', async () => {
    const first = await request('review', { userId:7 })
    const controller = new AbortController()
    const sameUser = request('review', { userId:7, options:{ signal:controller.signal } })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(state.waiters.some(row => row.status === 'waiting' && row.user_id === 7)).toBe(true)
    const differentUser = await request('review', { userId:8 })
    expect(state.leases.filter(row => row.status === 'active' && row.user_id === 8)).toHaveLength(1)
    controller.abort(new Error('same_user_cap'))
    await expect(sameUser).rejects.toThrow('same_user_cap')
    await Promise.all([first.release('test'), differentUser.release('test')])
  })

  it('scopes active capacity by model profile and rejects stale owner tokens', async () => {
    state.profilePolicies.set(2, { max_concurrency:1, reserve_execution_critical_slots:0, background_per_user_cap:1 })
    const profileOne = await request('review', { profileId:1, userId:11 })
    const profileTwo = await request('review', { profileId:2, userId:12 })
    expect(profileOne.leaseId).not.toBe(profileTwo.leaseId)
    const stale = { ...profileOne, ownerToken:'stale-owner' }
    await expect(releaseModelTaskCapacityLease(stale, 'stale')).resolves.toBe(false)
    expect(state.leases.find(row => row.lease_id === profileOne.leaseId).status).toBe('active')
    await Promise.all([profileOne.release('test'), profileTwo.release('test')])
  })

  it('reclaims an expired durable lease before admitting new work', async () => {
    state.leases.push({ lease_id:'expired-lease', owner_token:'expired-owner', model_profile_id:1,
      user_id:99, queue_class:'background', status:'active', lease_expires_at_utc_msc:Date.now() - 1 })
    const lease = await request('auto_platform', { userId:100 })
    expect(state.leases.find(row => row.lease_id === 'expired-lease').status).toBe('expired')
    await lease.release('test')
  })

  it('aborts a durable waiter before any provider callback can run', async () => {
    const holders = await Promise.all([request('review', { userId:1 }), request('review', { userId:2 }), request('review', { userId:3 })])
    const controller = new AbortController()
    const waiting = request('review', { userId:20, options:{ signal:controller.signal } })
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error('waiting_aborted'))
    await expect(waiting).rejects.toThrow('waiting_aborted')
    expect(state.waiters.some(row => row.user_id === 20 && row.status === 'cancelled')).toBe(true)
    await Promise.all(holders.map(holder => holder.release('test')))
  })

  it('retains an unknown-result lease conservatively and releases on explicit HTTP paths', async () => {
    const lease = await request('auto_platform', { userId:55 })
    const retained = await retainModelTaskCapacityLease(lease, { untilMs:Date.now() + 1000 })
    expect(retained).toBe(true)
    expect(state.leases.find(row => row.lease_id === lease.leaseId)).toMatchObject({ status:'active' })
    await expect(lease.release('http_429')).resolves.toBe(true)
    expect(state.leases.find(row => row.lease_id === lease.leaseId).status).toBe('released')
  })
})
