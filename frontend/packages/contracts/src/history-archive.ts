import { z } from 'zod'
import type { components } from './generated/http.js'
const id=z.string().regex(/^[1-9][0-9]{0,18}$/)
const provenance={identity_namespace:z.literal('retained-legacy'),executable:z.literal(false)}
const meta=z.object({request_id:z.string().min(1),generated_at:z.iso.datetime()})
const signal=z.object({legacy_id:id,symbol:z.string(),timeframe:z.string(),signal_type:z.string(),created_at_utc:z.iso.datetime()}).strict()
const execution=z.object({legacy_id:id,legacy_account_id:id.nullable(),symbol:z.string().nullable(),action:z.string(),status:z.string(),created_at_utc:z.iso.datetime()}).strict()
export const archivedSignalListResponseSchema=z.object({data:z.object({items:z.array(signal).max(100),next_cursor:z.string().nullable(),...provenance}).strict(),meta}).strict()
export const archivedSignalDetailResponseSchema=z.object({data:signal.extend({analysis:z.string().nullable(),reasoning:z.string().nullable(),inference_task_id:z.string().nullable(),...provenance}),meta}).strict()
export const archivedExecutionListResponseSchema=z.object({data:z.object({items:z.array(execution).max(100),next_cursor:z.string().nullable(),...provenance}).strict(),meta}).strict()
export const archivedExecutionDetailResponseSchema=z.object({data:execution.extend({trade_ticket:z.string().nullable(),pending_ticket:z.string().nullable(),error_code:z.string().nullable(),completed_at_utc:z.iso.datetime().nullable(),...provenance}),meta}).strict()
// Type compatibility is checked against the generated wire contract, independently of runtime parsing.
const wireCompatibility: z.ZodType<components['schemas']['getArchivedSignalResponse']> = archivedSignalDetailResponseSchema
const executionCompatibility: z.ZodType<components['schemas']['getArchivedExecutionResponse']> = archivedExecutionDetailResponseSchema
void wireCompatibility
void executionCompatibility

const decimal=z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/)
const archivedDeal=z.object({legacy_id:id,legacy_outcome_id:id,deal_ticket:z.string(),position_id:z.string().nullable(),order_ticket:z.string().nullable(),entry_type:z.number().int().nullable(),volume:decimal,price:decimal.nullable(),profit:decimal,commission:decimal,swap:decimal,fee:decimal,occurred_at_utc:z.iso.datetime().nullable()}).strict()
export const archivedExecutionDealsResponseSchema=z.object({data:z.object({items:z.array(archivedDeal).max(100),next_cursor:z.string().nullable(),legacy_execution_id:id,...provenance}).strict(),meta}).strict()
const dealsCompatibility: z.ZodType<components['schemas']['ArchivedExecutionDealsResponse']> = archivedExecutionDealsResponseSchema
void dealsCompatibility
