import { z } from 'zod'
export const modelConfigurationSchema=z.object({id:z.string(),name:z.string(),provider:z.string(),scope:z.enum(['user','platform']),base_url:z.string(),protocol:z.enum(['chat_completions','responses']),max_tokens:z.number().nullable(),has_key:z.boolean(),verified:z.boolean(),temperature:z.number().nullable().optional(),context_window_tokens:z.number().nullable().optional(),max_input_tokens:z.number().nullable().optional(),max_output_tokens:z.number().nullable().optional(),request_timeout_ms:z.number().nullable().optional(),thinking_enabled:z.boolean().optional(),reasoning_effort:z.enum(['low','medium','high','max']).nullable().optional(),revision:z.string()})
const meta=z.object({request_id:z.string(),generated_at:z.string()})
export const modelConfigurationResponseSchema=z.object({data:modelConfigurationSchema,meta})
export const modelConfigurationListResponseSchema=z.object({data:z.array(modelConfigurationSchema),meta})
export type ModelConfiguration=z.infer<typeof modelConfigurationSchema>

export const modelAssignmentsSchema=z.object({analysis:z.string().nullable(),trader:z.string().nullable(),review:z.string().nullable(),revision:z.string()})
export const modelAssignmentsResponseSchema=z.object({data:modelAssignmentsSchema,meta})
export const modelDeletedResponseSchema=z.object({data:z.object({id:z.string(),deleted:z.boolean()}),meta})
