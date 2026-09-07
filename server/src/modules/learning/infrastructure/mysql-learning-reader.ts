import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { CourseSummary, LearningReader, Lesson } from '../domain/learning.js'
const fields = `CAST(id AS CHAR) id,title,description,category_key category,access_level,
  CONCAT(LEFT(DATE_FORMAT(updated_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') updated_at,COALESCE(sort_order,0) sort_order`
export class MysqlLearningReader implements LearningReader {
  constructor(private readonly pool: Pool) {}
  async list(after: { order: number; id: string } | null, limit: number) {
    const [rows] = await this.pool.query<(RowDataPacket & CourseSummary)[]>(`SELECT ${fields.replace('title,description,', 'title,LEFT(description,240) description,')} FROM learning_courses WHERE status='published'
      ${after ? 'AND (COALESCE(sort_order,0)>? OR (COALESCE(sort_order,0)=? AND id>?))' : ''}
      ORDER BY COALESCE(sort_order,0),id LIMIT ?`, [...(after ? [after.order, after.order, after.id] : []), limit])
    return rows.map(mapCourse)
  }
  async course(id: string) {
    const [rows] = await this.pool.execute<(RowDataPacket & CourseSummary)[]>(`SELECT ${fields} FROM learning_courses WHERE id=? AND status='published'`, [id])
    return rows[0] ? mapCourse(rows[0]) : null
  }
  async lessons(id: string, userId: number | null): Promise<Lesson[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT CAST(l.id AS CHAR) id,l.title,CAST(l.duration_ms AS CHAR) duration_ms,
      p.id progress_id,CAST(p.revision AS CHAR) progress_revision,CAST(p.watched_ms AS CHAR) watched_ms,CAST(p.reported_duration_ms AS CHAR) reported_duration_ms,p.completed,
      CONCAT(LEFT(DATE_FORMAT(p.updated_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') progress_updated_at
      FROM learning_lessons l JOIN learning_courses c ON c.id=l.course_id AND c.status='published'
      LEFT JOIN learning_progress p ON p.lesson_id=l.id AND p.user_id=?
      WHERE l.course_id=? ORDER BY l.sort_order,l.id LIMIT 101`, [userId, id])
    if (!rows.length) return []
    const ids = rows.slice(0, 100).map(row => String(row.id))
    const [media] = await this.pool.query<RowDataPacket[]>(`SELECT CAST(lesson_id AS CHAR) lesson_id,source_kind,locator
      FROM learning_media_references WHERE lesson_id IN (${ids.map(() => '?').join(',')})`, ids)
    return rows.map(row => ({ id: String(row.id), title: String(row.title), duration_ms: row.duration_ms,
      progress: row.progress_id == null ? null : { watched_ms: row.watched_ms, reported_duration_ms: row.reported_duration_ms,
        completed: row.completed == null ? null : Number(row.completed) !== 0, updated_at: row.progress_updated_at, revision: row.progress_revision },
      resources: media.filter(item => String(item.lesson_id) === String(row.id)).flatMap(item => {
        const url = learningResourceUrl(String(item.source_kind), String(item.locator))
        return url ? [{ kind: String(item.source_kind), url }] : []
      }) }))
  }
}
export function learningResourceUrl(kind: string, locator: string): string | null {
  if (kind === 'bilibili_id' && /^BV[0-9A-Za-z]+$/.test(locator)) return `https://www.bilibili.com/video/${encodeURIComponent(locator)}`
  if (kind === 'youtube_id' && /^[0-9A-Za-z_-]{11}$/.test(locator)) return `https://www.youtube.com/watch?v=${encodeURIComponent(locator)}`
  if (kind === 'article_url') {
    try { const url = new URL(locator); if (url.protocol === 'https:' && !url.username && !url.password) return url.href } catch { return null }
  }
  return null
}

function mapCourse(row: RowDataPacket): CourseSummary {
  return { id: String(row.id), title: String(row.title), description: row.description, category: row.category,
    access_level: row.access_level, updated_at: row.updated_at, sort_order: Number(row.sort_order) }
}
