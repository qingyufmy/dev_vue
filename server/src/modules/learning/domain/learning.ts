export type CourseAccess = 'free' | 'logged_in' | 'plus_pro' | 'pro_only' | null
export interface CourseSummary {
  id: string; title: string; description: string | null; category: string | null
  access_level: CourseAccess; updated_at: string | null; sort_order: number
}
export interface Lesson {
  id: string; title: string; duration_ms: string | null
  progress: { watched_ms: string | null; reported_duration_ms: string | null; completed: boolean | null; updated_at: string | null; revision: string } | null
  resources: Array<{ kind: string; url: string }>
}
export class LearningError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
export interface LearningReader {
  list(after: { order: number; id: string } | null, limit: number): Promise<CourseSummary[]>
  course(id: string): Promise<CourseSummary | null>
  lessons(id: string, userId: number | null): Promise<Lesson[]>
}
export interface LearningMembershipReader { activePlan(userId: number, now: Date): Promise<'free' | 'plus' | 'pro'> }
