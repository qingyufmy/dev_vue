import { z } from 'zod'
import type { components } from './generated/http.js'

const user = z.object({ id: z.string().min(1), display_name: z.string() }).strict()
export const installationAuthorizationSchema = z.object({
  authorization_id: z.string().min(1), installation_id: z.string().min(1), device_name: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'revoked']), revision: z.string().regex(/^\d+$/),
  created_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }), current_user: user,
}).strict()
export const installationAuthorizationResponseSchema: z.ZodType<components['schemas']['BridgeInstallationConfirmationResponse']> = z.object({
  data: installationAuthorizationSchema,
  meta: z.object({ request_id: z.string(), generated_at: z.string().datetime({ offset: true }) }).strict(),
}).strict()
export type InstallationAuthorization = z.infer<typeof installationAuthorizationSchema>
export const installationDecisionSchema: z.ZodType<components['schemas']['BridgeInstallationDecision']> = z.object({
  decision: z.enum(['approved', 'denied']), expected_revision: z.string().regex(/^\d+$/), current_user_id: z.string().min(1),
}).strict()
export type InstallationDecision = components['schemas']['BridgeInstallationDecision']
