import { z } from 'zod'
const utc = z.string().datetime().nullable()
const decimal = z.string().regex(/^\d+$/).nullable()
const revision = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => value.length <= 20 && !/[^0-9]/.test(value) && BigInt(value) <= 18446744073709551615n)
export const learningCourseSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/), title: z.string(), description: z.string().nullable(), category: z.string().nullable(),
  access_level: z.enum(['free', 'logged_in', 'plus_pro', 'pro_only']).nullable(), updated_at: utc, sort_order: z.number().int(),
})
export const learningListSchema = z.object({ items: z.array(learningCourseSchema).max(20), next_cursor: z.string().nullable() })
export const learningDetailSchema = z.object({
  course: learningCourseSchema, access: z.enum(['allowed', 'login_required', 'membership_required']), lessons_truncated: z.boolean(),
  viewer_user_id: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  lessons: z.array(z.object({ id: z.string(), title: z.string(), duration_ms: decimal,
    progress: z.object({ watched_ms: decimal, reported_duration_ms: decimal, completed: z.boolean().nullable(), updated_at: utc, revision }).nullable(),
    resources: z.array(z.object({ kind: z.string(), url: z.string().url().startsWith('https://') })),
  })).max(100),
}).refine(value => value.access === 'allowed' || value.lessons.length === 0)
export type LearningCourse = z.infer<typeof learningCourseSchema>
export type LearningDetail = z.infer<typeof learningDetailSchema>
export const learningCompletionSchema = z.object({ lesson_id: z.string().regex(/^[1-9][0-9]*$/), completed: z.boolean(),
  revision, updated_at: z.string().datetime(), replayed: z.boolean() }).strict()
