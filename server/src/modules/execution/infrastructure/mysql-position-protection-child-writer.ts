import type { PoolConnection } from 'mysql2/promise'
import type { PositionProtectionChild } from '../domain/position-protection-child.js'
import { sha256Canonical } from '../domain/execution.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

/** Caller owns the source locks and transaction; this is never an independent commit. */
export async function insertPositionProtectionChild(db: PoolConnection, child: PositionProtectionChild): Promise<void> {
  const o = child.operation, i = child.intent, time = bridgeCommandSqlTime(i.createdAt)
  await db.execute(`INSERT INTO operations
    (id,user_id,trading_account_id,kind,status,source_type,source_id,idempotency_scope,idempotency_key,request_sha256,
     resource_type,resource_id,parent_operation_id,error_code,accepted_at_utc,updated_at_utc,completed_at_utc,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,1)`,
  [o.id,o.userId,o.accountId,o.kind,o.status,o.sourceType,o.sourceId,o.idempotencyScope,o.idempotencyKey,o.requestHash,o.resourceType,o.resourceId,o.parentOperationId ?? null,time,time])
  await db.execute(`INSERT INTO operation_events
    (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc)
    VALUES (?,'operation.queued',NULL,'queued',NULL,NULL,1,JSON_OBJECT(),?)`, [o.id,time])
  await db.execute(`INSERT INTO execution_intents
    (id,operation_id,risk_decision_id,trade_decision_id,user_command_id,risk_decision_revision,account_risk_revision,user_id,trading_account_id,
     action_id,action_kind,source_type,source_id,position_workflow_id,idempotency_key,request_sha256,expected_state_sha256,
     status,expires_at_utc,error_code,created_at_utc,updated_at_utc,completed_at_utc,revision)
    VALUES (?,?,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,1)`,
  [i.id,i.operationId,Number(i.action.expectedState.riskRevision),i.userId,i.accountId,i.actionId,i.actionKind,i.sourceType,i.sourceId,i.sourceId,
    i.idempotencyKey,i.requestHash,i.expectedStateHash,i.status,bridgeCommandSqlTime(i.expiresAt),time,time])
  const action = JSON.stringify(i.action), expected = JSON.stringify(i.action.expectedState)
  await db.execute(`INSERT INTO execution_intent_payloads
    (execution_intent_id,action_json,action_sha256,expected_state_json,expected_state_sha256,payload_bytes) VALUES (?,?,?,?,?,?)`,
  [i.id,action,sha256Canonical(i.action),expected,i.expectedStateHash,Buffer.byteLength(action)+Buffer.byteLength(expected)])
  await db.execute(`INSERT INTO execution_intent_events
    (execution_intent_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc)
    VALUES (?,'execution.intent.prepared',NULL,'prepared',NULL,NULL,1,JSON_OBJECT(),?)`, [i.id,time])
}
