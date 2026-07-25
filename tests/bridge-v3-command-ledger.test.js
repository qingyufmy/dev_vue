import { describe, expect, it, vi } from 'vitest'

import {
  commandPayloadHash,
  createCommandLedgerEntry,
  markCommandDeliveryUncertain,
  markCommandDispatched,
  recordCommandResult,
  stableJson,
} from '../server/bridge-v3/command-ledger.js'

const NOW = 1_800_000_000_000

function command(overrides = {}) {
  return {
    v:3,
    type:'command',
    message_id:'msg_01JLEDGER00001',
    sent_at_utc_msc:NOW,
    command_id:'command_01JLEDGER00001',
    terminal_instance_id:'terminal_01JLEDGER01',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    issued_at_utc_msc:NOW,
    deadline_utc_msc:NOW + 10_000,
    action:'place_order',
    params:{ symbol:'XAUUSD', volume:'0.01', side:'buy' },
    ...overrides,
  }
}

function ledgerRow(message = command(), overrides = {}) {
  return {
    command_id:message.command_id,
    user_id:42,
    terminal_instance_id:message.terminal_instance_id,
    broker_server:message.account_ref.broker_server,
    login_account:message.account_ref.login,
    connection_epoch:message.connection_epoch,
    action:message.action,
    params_json:stableJson(message.params),
    payload_hash:commandPayloadHash(message, 42),
    status:'queued',
    deadline_at_utc_msc:message.deadline_utc_msc,
    dispatch_attempt_count:0,
    ...overrides,
  }
}

function result(overrides = {}) {
  return {
    v:3,
    type:'command_result',
    message_id:'msg_01JLEDGER00002',
    sent_at_utc_msc:NOW + 100,
    command_id:'command_01JLEDGER00001',
    terminal_instance_id:'terminal_01JLEDGER01',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    status:'succeeded',
    completed_at_utc_msc:NOW + 100,
    evidence:{ observed_at_utc_msc:NOW + 100, order_tickets:['1001'], deal_tickets:['2001'] },
    ...overrides,
  }
}

function transactionWith(row) {
  const run = vi.fn()
    .mockResolvedValueOnce([[row], []])
    .mockResolvedValue([[{ affectedRows:1 }], []])
  return { run, transactionFn:fn => fn(run) }
}

describe('Bridge v3 durable command ledger', () => {
  it('creates one immutable command and returns an identical retry', async () => {
    const message = command()
    const queryRunFn = vi.fn().mockResolvedValue({ changes:1 })
    const queryOneFn = vi.fn().mockResolvedValue(ledgerRow(message))
    await expect(createCommandLedgerEntry(message, {
      userId:42, nowUtcMsc:NOW, queryRunFn, queryOneFn,
    })).resolves.toMatchObject({ created:true, command:{ status:'queued' } })
    expect(queryRunFn.mock.calls[0][0]).toContain('INSERT IGNORE INTO bridge_v3_command_ledger')

    queryRunFn.mockResolvedValue({ changes:0 })
    await expect(createCommandLedgerEntry(message, {
      userId:42, nowUtcMsc:NOW, queryRunFn, queryOneFn,
    })).resolves.toMatchObject({ created:false })
  })

  it('rejects reuse of a command ID with a different immutable payload', async () => {
    const original = command()
    const changed = command({ params:{ symbol:'XAUUSD', volume:'1.00', side:'buy' } })
    await expect(createCommandLedgerEntry(changed, {
      userId:42,
      nowUtcMsc:NOW,
      queryRunFn:vi.fn().mockResolvedValue({ changes:0 }),
      queryOneFn:vi.fn().mockResolvedValue(ledgerRow(original)),
    })).rejects.toMatchObject({ code:'bridge_command_id_conflict' })
  })

  it('persists dispatch before the websocket write can happen', async () => {
    const { run, transactionFn } = transactionWith(ledgerRow())
    await expect(markCommandDispatched('command_01JLEDGER00001', {
      connectionEpoch:7, nowUtcMsc:NOW + 1, transactionFn,
    })).resolves.toMatchObject({ status:'dispatched', dispatch_attempt_count:1 })
    expect(run.mock.calls[1][0]).toContain("SET status = 'dispatched'")
    expect(run.mock.calls[2][0]).toContain('INSERT INTO bridge_v3_command_events')
  })

  it('does not redispatch an in-flight command unless reconciliation explicitly authorizes it', async () => {
    const inflight = ledgerRow(command(), { status:'dispatched', dispatch_attempt_count:1 })
    const blocked = transactionWith(inflight)
    await expect(markCommandDispatched(inflight.command_id, {
      connectionEpoch:7, nowUtcMsc:NOW + 2, transactionFn:blocked.transactionFn,
    })).rejects.toMatchObject({ code:'bridge_command_reconciliation_required' })
    expect(blocked.run).toHaveBeenCalledTimes(1)

    const authorized = transactionWith(inflight)
    await expect(markCommandDispatched(inflight.command_id, {
      connectionEpoch:7, allowRedispatch:true, nowUtcMsc:NOW + 2, transactionFn:authorized.transactionFn,
    })).resolves.toMatchObject({ status:'dispatched', dispatch_attempt_count:2 })
  })

  it('expires an unsent command and rejects an old epoch', async () => {
    const expired = ledgerRow(command(), { deadline_at_utc_msc:NOW - 1 })
    const expiredTx = transactionWith(expired)
    await expect(markCommandDispatched(expired.command_id, {
      connectionEpoch:7, nowUtcMsc:NOW, transactionFn:expiredTx.transactionFn,
    })).rejects.toMatchObject({ code:'bridge_command_expired' })
    expect(expiredTx.run.mock.calls[1][0]).toContain("status = 'expired'")

    const epochTx = transactionWith(ledgerRow())
    await expect(markCommandDispatched('command_01JLEDGER00001', {
      connectionEpoch:8, nowUtcMsc:NOW, transactionFn:epochTx.transactionFn,
    })).rejects.toMatchObject({ code:'bridge_command_epoch_mismatch' })
  })

  it('moves a timed-out dispatched command to uncertain instead of retryable failure', async () => {
    const { run, transactionFn } = transactionWith(ledgerRow(command(), { status:'dispatched', dispatch_attempt_count:1 }))
    await expect(markCommandDeliveryUncertain('command_01JLEDGER00001', {
      nowUtcMsc:NOW + 5_000, transactionFn,
    })).resolves.toMatchObject({ duplicate:false, command:{ status:'uncertain' } })
    expect(run.mock.calls[1][0]).toContain("SET status = 'uncertain'")
  })

  it('accepts a matching result once and treats the same replay as idempotent', async () => {
    const message = result()
    const first = transactionWith(ledgerRow(command(), { status:'dispatched', dispatch_attempt_count:1 }))
    await expect(recordCommandResult(message, { nowUtcMsc:NOW + 200, transactionFn:first.transactionFn }))
      .resolves.toMatchObject({ duplicate:false, command:{ status:'succeeded' } })
    expect(first.run.mock.calls[1][0]).toContain('SET status = ?')

    const hash = first.run.mock.calls[1][1][4]
    const replay = transactionWith(ledgerRow(command(), {
      status:'succeeded', result_status:'succeeded', result_hash:hash, result_json:stableJson(message),
    }))
    await expect(recordCommandResult(message, { nowUtcMsc:NOW + 300, transactionFn:replay.transactionFn }))
      .resolves.toMatchObject({ duplicate:true })
    expect(replay.run).toHaveBeenCalledTimes(1)
  })

  it('rejects results from another account, terminal, or connection epoch', async () => {
    for (const changed of [
      result({ account_ref:{ broker_server:'Broker-Demo', login:'999' } }),
      result({ terminal_instance_id:'terminal_01JLEDGER99' }),
      result({ connection_epoch:8 }),
    ]) {
      const tx = transactionWith(ledgerRow(command(), { status:'dispatched' }))
      await expect(recordCommandResult(changed, { nowUtcMsc:NOW + 200, transactionFn:tx.transactionFn }))
        .rejects.toMatchObject({ code:'bridge_command_route_mismatch' })
      expect(tx.run).toHaveBeenCalledTimes(1)
    }
  })

  it('requires an explicit reconciliation path to replace an uncertain outcome', async () => {
    const uncertainResult = result({ status:'uncertain', evidence:{ observed_at_utc_msc:NOW + 100 } })
    const existing = ledgerRow(command(), {
      status:'uncertain', result_status:'uncertain', result_hash:'a'.repeat(64), result_json:stableJson(uncertainResult),
    })
    const blocked = transactionWith(existing)
    await expect(recordCommandResult(result(), { nowUtcMsc:NOW + 300, transactionFn:blocked.transactionFn }))
      .rejects.toMatchObject({ code:'bridge_command_result_conflict' })

    const reconciled = transactionWith(existing)
    await expect(recordCommandResult(result(), {
      nowUtcMsc:NOW + 300, allowUncertainResolution:true, transactionFn:reconciled.transactionFn,
    })).resolves.toMatchObject({ duplicate:false, command:{ status:'succeeded' } })
    expect(reconciled.run.mock.calls[2][1][1]).toBe('reconciled')
  })
})
