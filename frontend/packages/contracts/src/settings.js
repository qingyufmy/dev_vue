import { z } from 'zod';
const identifier = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/).refine(v => !/[^a-z0-9_]/.test(v));
const revision = z.string().min(1).max(20).regex(/^[1-9][0-9]*$/).refine(v => !/[^0-9]/.test(v) && BigInt(v) <= 18446744073709551615n);
const type = z.enum(['string', 'boolean', 'integer', 'enum', 'json_array']);
const meta = z.object({ request_id: z.string().min(1), generated_at: z.iso.datetime({ offset: true }) });
export const settingScopeSchema = z.object({ namespace: identifier, key: identifier }).strict();
export const settingRequestKeySchema = z.string().length(36).regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const settingUpdateBodySchema = settingScopeSchema.extend({ value_type: type, expected_revision: revision.refine(v => BigInt(v) < 18446744073709551615n), value: z.string() }).strict();
const fields = { setting_id: z.string().regex(/^[1-9][0-9]*$/).max(10).refine(v => !/[^0-9]/.test(v) && BigInt(v) <= 2147483647n), namespace: identifier, key: identifier,
    revision, value_state: z.enum(['null', 'empty', 'text']) };
const protectedValue = z.object({ ...fields, value_type: z.enum(['string', 'boolean', 'integer', 'enum', 'json_array', 'credential']), sensitivity: z.literal('secret'), protected: z.literal(true) }).strict();
const plainValue = z.object({ ...fields, value_type: type, sensitivity: z.enum(['public', 'restricted']), protected: z.literal(false), value: z.string().nullable() }).strict()
    .refine(v => v.value_state === 'null' ? v.value === null : v.value_state === 'empty' ? v.value === '' : typeof v.value === 'string' && v.value.length > 0);
export const adminSettingResponseSchema = z.object({ data: z.union([protectedValue, plainValue]), meta });
export const settingUpdateResponseSchema = z.object({ data: z.object({ setting_id: fields.setting_id, revision, replayed: z.boolean() }).strict(), meta });
