import { LearningError, type LearningReader, type LearningMembershipReader } from '../domain/learning.js'
export class LearningService {
  constructor(private readonly reader: LearningReader, private readonly memberships: LearningMembershipReader) {}
  async list(cursor?: string) {
    let after = null
    if (cursor !== undefined) {
      if (typeof cursor !== 'string') throw new LearningError('learning_cursor_invalid', 400)
      const match = /^(-?\d{1,10}):([1-9]\d{0,9})$/.exec(cursor)
      if (!match || Math.abs(Number(match[1])) > 2147483648 || Number(match[2]) > 2147483647) throw new LearningError('learning_cursor_invalid', 400)
      after = { order: Number(match[1]), id: match[2]! }
    }
    const rows = await this.reader.list(after, 21)
    const items = rows.slice(0, 20), last = items.at(-1)
    return { items, next_cursor: rows.length > 20 && last ? `${last.sort_order}:${last.id}` : null }
  }
  async detail(id: string, userId: number | null, now = new Date()) {
    if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) throw new LearningError('learning_course_not_found', 404)
    const course = await this.reader.course(id)
    if (!course) throw new LearningError('learning_course_not_found', 404)
    const plan = userId === null ? 'free' : await this.memberships.activePlan(userId, now)
    const allowed = course.access_level === 'free' || userId !== null && (course.access_level === 'logged_in'
      || course.access_level === 'plus_pro' && (plan === 'plus' || plan === 'pro') || course.access_level === 'pro_only' && plan === 'pro')
    if (!allowed) return { course, access: userId === null ? 'login_required' as const : 'membership_required' as const, lessons: [], lessons_truncated: false }
    const lessons = await this.reader.lessons(id, userId)
    return { course, access: 'allowed' as const, lessons: lessons.slice(0, 100), lessons_truncated: lessons.length > 100 }
  }
}
