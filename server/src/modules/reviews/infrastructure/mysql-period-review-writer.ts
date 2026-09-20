import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { selectPeriodReviewTrades } from '../application/period-review-inventory.js'
import type { ReadyReviewTrade } from '../application/manual-candidate-collector.js'
import { freezeReviewPeriod } from '../domain/review-period.js'
import { reviewEvidenceHash, verifiedReviewEvidence } from './review-evidence-integrity.js'

type Selection = Extract<ReturnType<typeof selectPeriodReviewTrades>, { status:'selected' }>
interface Source { caseId:string; hash:string; evidence:Record<string,unknown>; recordId:string }
interface Group { strategyId:string; versionId:string; sources:Source[]; existingId?:string }

/** All source validation precedes writes. Caller supplies authorized inventory and owns the transaction. */
export function createMysqlPeriodReviewWriter(connection:PoolConnection) {
  return {async write(userId:number,input:Selection) {
    const selection=structuredClone(input),period=freezeReviewPeriod(selection.period,selection.asOfUtcMsc)
    if(!Number.isSafeInteger(userId)||userId<1||!selection.records.length||selection.records.length>1000) throw Error('period_review_scope_invalid')
    const scopeKeys=selection.records.map(r=>`system:${selection.accountId}:${r.id}`)
    const [rows]=await connection.execute<RowDataPacket[]>(`SELECT c.id,c.scope_key,CAST(c.trader_strategy_id AS CHAR) strategy_id,
      CAST(c.trader_strategy_version_id AS CHAR) version_id,p.evidence_json,p.evidence_sha256,p.payload_bytes
      FROM review_cases_v4 c JOIN review_evidence_payloads_v4 p ON p.review_case_id=c.id AND p.evidence_revision=c.evidence_revision
      WHERE c.user_id=? AND c.trading_account_id=? AND c.kind='trade' AND c.legacy_source_table IS NULL
        AND c.status<>'archived' AND c.evidence_status='complete' AND c.scope_key IN (${scopeKeys.map(()=>'?').join(',')}) FOR SHARE`,
    [userId,selection.accountId,...scopeKeys])
    if(rows.length!==selection.records.length) return {status:'unresolved' as const,reason:'period_single_trade_evidence_missing'}
    if(rows.reduce((n,r)=>n+Number(r.payload_bytes),0)>8*1024*1024) return {status:'unresolved' as const,reason:'period_evidence_budget_exceeded'}
    const byKey=new Map(rows.map(r=>[String(r.scope_key),r])),groups=new Map<string,Group>()
    for(const record of selection.records){
      const row=byKey.get(`system:${selection.accountId}:${record.id}`)
      if(!row) return {status:'unresolved' as const,reason:'period_single_trade_evidence_missing'}
      const evidence=verifiedReviewEvidence(row.evidence_json,row.evidence_sha256),trade=evidence.trade as ReadyReviewTrade
      const execution=evidence.execution as {strategyId?:string;strategyVersionId?:string}|undefined
      if(evidence.source!=='system_trade'||trade?.evidence.userId!==userId||trade.evidence.accountId!==selection.accountId
        ||trade.evidence.recordId!==record.id||trade.evidence.evidenceHash!==record.evidenceHash
        ||Date.parse(trade.evidence.closedAt)!==record.closedAtUtcMsc||!Array.isArray(evidence.contexts)
        ||evidence.contextHash!==reviewEvidenceHash({contexts:evidence.contexts})
        ||execution?.strategyId!==row.strategy_id||execution?.strategyVersionId!==row.version_id
        ||(trade.evidence.projection as {accountCurrency?:unknown}).accountCurrency!==selection.accountCurrency){
        return {status:'unresolved' as const,reason:'period_single_trade_source_changed'}
      }
      const key=JSON.stringify([row.strategy_id,row.version_id])
      const group=groups.get(key)??{strategyId:String(row.strategy_id),versionId:String(row.version_id),sources:[]}
      group.sources.push({caseId:String(row.id),hash:String(row.evidence_sha256),evidence,recordId:record.id});groups.set(key,group)
    }
    const prepared=[]
    for(const group of [...groups.values()].sort((a,b)=>a.strategyId.localeCompare(b.strategyId)||a.versionId.localeCompare(b.versionId))){
      group.sources.sort((a,b)=>a.recordId.localeCompare(b.recordId))
      const key=`period:${selection.accountId}:${period.key}:${group.strategyId}:${group.versionId}`
      const identityHash=reviewEvidenceHash({period,strategyId:group.strategyId,versionId:group.versionId,
        sources:group.sources.map(s=>({id:s.caseId,hash:s.hash})),exclusions:selection.exclusions,accountCurrency:selection.accountCurrency})
      const [existing]=await connection.execute<RowDataPacket[]>(`SELECT c.id,p.evidence_json,p.evidence_sha256
        FROM review_cases_v4 c JOIN review_evidence_payloads_v4 p ON p.review_case_id=c.id AND p.evidence_revision=c.evidence_revision
        WHERE c.user_id=? AND c.kind=? AND c.scope_key=? FOR UPDATE`,[userId,period.kind,key])
      if(existing.length){
        if(existing.length!==1||verifiedReviewEvidence(existing[0]!.evidence_json,existing[0]!.evidence_sha256).inventoryIdentityHash!==identityHash){
          return {status:'unresolved' as const,reason:'period_review_source_changed'}
        }
        group.existingId=String(existing[0]!.id)
      }
      prepared.push({group,key,identityHash})
    }
    const results=[]
    for(const {group,key,identityHash} of prepared){
      if(group.existingId){results.push({status:'unchanged' as const,caseId:group.existingId});continue}
      const id=randomUUID(),jobId=randomUUID()
      const frozen={schema_version:'review-evidence.v4.4',source:'system_period',period,accountCurrency:selection.accountCurrency,
        asOfUtcMsc:selection.asOfUtcMsc,completionHash:selection.completionHash,inventoryIdentityHash:identityHash,
        excludedTrades:selection.exclusions,strategyId:group.strategyId,strategyVersionId:group.versionId,trades:group.sources}
      const json=JSON.stringify(frozen),hash=reviewEvidenceHash(frozen)
      await connection.execute(`INSERT INTO review_cases_v4
        (id,user_id,trading_account_id,kind,scope_key,trader_strategy_id,trader_strategy_version_id,terminal_period_start_utc,
         terminal_period_end_utc,terminal_timezone_offset_minutes,status,evidence_status,evidence_revision,evidence_sha256,
         review_eligible_at_utc,created_at_utc,updated_at_utc,revision)
        VALUES (?,?,?,?,?,?,?, ?,?,?,'queued','complete',1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1)`,
      [id,userId,selection.accountId,period.kind,key,group.strategyId,group.versionId,
        new Date(period.start.utcMsc).toISOString().slice(0,23).replace('T',' '),new Date(period.end.utcMsc).toISOString().slice(0,23).replace('T',' '),period.end.offsetMinutes,hash])
      await connection.execute(`INSERT INTO review_evidence_payloads_v4
        (review_case_id,evidence_revision,evidence_json,evidence_sha256,payload_bytes,created_at_utc) VALUES (?,1,?,?,?,UTC_TIMESTAMP(3))`,[id,json,hash,Buffer.byteLength(json)])
      for(const source of group.sources) await connection.execute(`INSERT INTO review_case_sources_v4
        (review_case_id,source_kind,source_id,relation_kind,source_sha256,source_metadata_json,created_at_utc)
        VALUES (?,'period_review',?,'direct',?,?,UTC_TIMESTAMP(3))`,[id,source.caseId,source.hash,JSON.stringify({recordId:source.recordId})])
      await connection.execute(`INSERT INTO review_jobs_v4
        (id,review_case_id,generation,mode,status,evidence_revision,input_sha256,progress_percent,current_stage,created_at_utc,updated_at_utc,revision)
        VALUES (?,?,1,'initial','queued',1,?,0,'queued',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1)`,[jobId,id,hash])
      await connection.execute(`INSERT INTO review_job_events_v4 (review_job_id,event_type,from_status,to_status,metadata_json,occurred_at_utc)
        VALUES (?,'review_queued',NULL,'queued','{}',UTC_TIMESTAMP(3))`,[jobId])
      for(const [aggregate,aggregateId,type,payload] of [
        ['review_job',jobId,'review.job.requested',{review_job_id:jobId,review_case_id:id,generation:1}],
        ['review_case',id,'review.case.changed',{review_case_id:id,status:'queued',current_version_id:null,revision:'1'}],
      ] as const) await connection.execute(`INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
        VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[randomUUID(),aggregate,aggregateId,type,JSON.stringify(payload)])
      results.push({status:'queued' as const,caseId:id,jobId})
    }
    return {status:'collected' as const,results}
  }}
}
