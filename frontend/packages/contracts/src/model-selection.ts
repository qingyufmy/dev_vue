import { z } from 'zod'

export const modelSelectionResponseSchema = z.object({
  data: z.object({ selected_model_profile_id: z.string().nullable(), items: z.array(z.object({
    id: z.string(), name: z.string(), scope: z.enum(['user', 'platform']), available: z.boolean(), reason: z.string().nullable(),
  })) }),
  meta: z.object({ request_id: z.string(), generated_at: z.string() }),
})
export type ModelSelection = z.infer<typeof modelSelectionResponseSchema>['data']
