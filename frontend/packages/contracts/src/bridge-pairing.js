import { z } from 'zod';
export const bridgePairingRequestSchema = z.object({ code_hash: z.string().length(64).regex(/^[0-9a-f]+$/) }).strict();
export const bridgePairingResponseSchema = z.object({
    data: z.object({
        pairing_id: z.uuid(),
        profile_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        expires_at: z.iso.datetime({ offset: true }),
    }).strict(),
    meta: z.object({ request_id: z.string().min(1), generated_at: z.iso.datetime({ offset: true }) }).strict(),
}).strict();
