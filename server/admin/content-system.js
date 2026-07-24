import { queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { fetchBilibiliVideo } from '../utils.js'
import { deleteCourseAttachmentDirectory } from '../course-attachments.js'

const COURSE_CATEGORIES = new Set(['morning', 'indicator', 'pattern', 'strategy', 'advanced'])
const COURSE_CONTENT_TYPES = new Set(['video', 'article'])

function serializeCourse(row) {
  if (!row) return null
  return {
    id:Number(row.episode_id), episode_id:Number(row.episode_id), number:Number(row.number || 0),
    title:row.title || '', description:row.description || '', category:row.category || '',
    content_type:row.content_type || 'video', duration:row.duration || '', youtube_id:row.youtube_id || '',
    bilibili_id:row.bilibili_id || '', cover:row.cover || '', gradient:row.gradient || '',
    article_url:row.article_url || '', article_object_key:row.article_object_key || '',
    access_level:row.access_level || 'free', status:row.status || 'draft', sort_order:Number(row.sort_order || 0),
    quiz_count:Number(row.quiz_count || 0), mindmap_count:Number(row.mindmap_count || 0),
    knowledge_count:Number(row.knowledge_count || 0), attachment_count:Number(row.attachment_count || 0),
    created_at:row.created_at || null, updated_at:row.updated_at || null,
  }
}

function number(value) { return Number(value || 0) }
function pageParams(page, pageSize) {
  return { page:Math.max(1, Math.trunc(Number(page) || 1)), pageSize:Math.min(100, Math.max(5, Math.trunc(Number(pageSize) || 20))) }
}

export async function getAdminContentSystemOverview() {
  const [summary, categories, release] = await Promise.all([
    queryOne(`SELECT
      (SELECT COUNT(*) FROM courses) AS courses_total,
      (SELECT COUNT(*) FROM courses WHERE status = 'published') AS courses_published,
      (SELECT COUNT(*) FROM courses WHERE status = 'draft') AS courses_draft,
      (SELECT COUNT(*) FROM feedback) AS feedback_total,
      (SELECT COUNT(*) FROM feedback WHERE created_at >= CURDATE()) AS feedback_today,
      (SELECT COUNT(*) FROM course_resources WHERE type = 'attachment') AS attachments_total,
      (SELECT COUNT(DISTINCT category) FROM system_config) AS config_categories`),
    queryAll(`SELECT category, COUNT(*) AS item_count, MAX(updated_at) AS updated_at
      FROM system_config GROUP BY category ORDER BY category`),
    queryAll("SELECT `key`, `value`, updated_at FROM system_config WHERE category = 'changelog' AND `key` IN ('version','content')"),
  ])
  const releaseMap = Object.fromEntries(release.map(item => [item.key, item]))
  return {
    summary:Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, number(value)])),
    categories:categories.map(item => ({ ...item, item_count:number(item.item_count) })),
    release:{ version:releaseMap.version?.value || '', content:releaseMap.content?.value || '', updated_at:releaseMap.version?.updated_at || releaseMap.content?.updated_at || null },
  }
}

export async function listAdminCourses({ page, pageSize, search = '', status = 'all' } = {}) {
  const paging = pageParams(page, pageSize)
  const where = [], params = []
  const keyword = String(search || '').trim().slice(0, 100)
  if (keyword) { where.push('(title LIKE ? OR description LIKE ? OR category LIKE ?)'); params.push(`%${keyword}%`,`%${keyword}%`,`%${keyword}%`) }
  if (['published','draft','archived'].includes(status)) { where.push('status = ?'); params.push(status) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [totalRow, rows] = await Promise.all([
    queryOne(`SELECT COUNT(*) AS total FROM courses ${clause}`, params),
    queryAll(`SELECT episode_id, number, title, description, category, content_type, duration, cover,
      access_level, status, quiz_count, mindmap_count, knowledge_count, created_at, updated_at,
      (SELECT COUNT(*) FROM course_resources resource WHERE resource.episode_id = courses.episode_id AND resource.type = 'attachment') AS attachment_count
      FROM courses ${clause} ORDER BY created_at DESC, episode_id DESC LIMIT ? OFFSET ?`, [...params,paging.pageSize,(paging.page-1)*paging.pageSize]),
  ])
  const total=number(totalRow?.total)
  return { courses:rows.map(row=>({ ...row, id:number(row.episode_id), number:number(row.number), quiz_count:number(row.quiz_count), mindmap_count:number(row.mindmap_count), knowledge_count:number(row.knowledge_count), attachment_count:number(row.attachment_count) })), pagination:{page:paging.page,page_size:paging.pageSize,total,total_pages:Math.max(1,Math.ceil(total/paging.pageSize))} }
}

export async function getAdminCourse(courseId) {
  const id = Number(courseId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_course_id')
  return serializeCourse(await queryOne(`SELECT courses.*,
    (SELECT COUNT(*) FROM course_resources resource WHERE resource.episode_id = courses.episode_id AND resource.type = 'attachment') AS attachment_count
    FROM courses WHERE episode_id = ?`, [id]))
}

export async function saveAdminCourse(input = {}) {
  const episodeId = Number(input.id || input.episode_id || 0)
  const category = String(input.category || '').trim()
  const contentType = String(input.content_type || '').trim()
  const title = String(input.title || '').trim()
  if (!title) throw new Error('course_title_required')
  if (!COURSE_CATEGORIES.has(category)) throw new Error('invalid_course_category')
  if (!COURSE_CONTENT_TYPES.has(contentType)) throw new Error('invalid_course_content_type')
  const status = ['published','draft','archived'].includes(input.status) ? input.status : 'draft'
  const accessLevel = ['free','logged_in','plus_pro','pro_only'].includes(input.access_level) ? input.access_level : 'free'
  let cover = String(input.cover || '').trim()
  let duration = String(input.duration || '').trim()
  const bilibiliId = String(input.bilibili_id || '').trim()
  if (bilibiliId) {
    try {
      const video = await fetchBilibiliVideo(bilibiliId)
      if (video?.cover && !cover) cover = video.cover
      if (video?.duration && !duration) duration = video.duration
    } catch (error) { console.error('[AdminContent] Bilibili metadata failed:', error.message) }
  }
  const values = [
    Math.max(0, Number(input.number || 0)), title, String(input.description || '').trim(), category, contentType,
    duration, String(input.youtube_id || '').trim(), bilibiliId, cover, accessLevel,
    Math.max(0, Number(input.sort_order || 0)), String(input.article_url || '').trim(),
    String(input.article_object_key || '').trim(), status,
  ]
  if (episodeId > 0) {
    const exists = await queryOne('SELECT episode_id FROM courses WHERE episode_id = ?', [episodeId])
    if (!exists) throw new Error('course_not_found')
    await queryRun(`UPDATE courses SET number=?, title=?, description=?, category=?, content_type=?, duration=?,
      youtube_id=?, bilibili_id=?, cover=?, access_level=?, sort_order=?, article_url=?, article_object_key=?,
      status=?, updated_at=NOW() WHERE episode_id=?`, [...values, episodeId])
    return getAdminCourse(episodeId)
  }
  const maxRow = await queryOne('SELECT COALESCE(MAX(episode_id), 0) AS max_id FROM courses')
  const newId = Number(maxRow?.max_id || 0) + 1
  if (!values[0]) values[0] = newId
  await queryRun(`INSERT INTO courses (episode_id, number, title, description, category, content_type, duration,
    youtube_id, bilibili_id, cover, access_level, sort_order, article_url, article_object_key, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [newId, ...values])
  return getAdminCourse(newId)
}

export async function deleteAdminCourse(courseId) {
  const id = Number(courseId)
  const course = await getAdminCourse(id)
  if (!course) throw new Error('course_not_found')
  await withTransaction(async run => {
    await run('DELETE FROM quiz_questions WHERE episode_id = ?', [id])
    await run('DELETE FROM course_resources WHERE episode_id = ?', [id])
    await run('DELETE FROM video_streams WHERE episode_id = ?', [id])
    await run('DELETE FROM progress WHERE episode_id = ?', [id])
    await run('DELETE FROM comments WHERE episode_id = ?', [id])
    await run('DELETE FROM courses WHERE episode_id = ?', [id])
  })
  try { deleteCourseAttachmentDirectory(id) } catch (error) { console.error('[AdminContent] attachment cleanup failed:', error.message) }
  return course
}

export async function listAdminFeedback({ page, pageSize, search = '', type = 'all' } = {}) {
  const paging=pageParams(page,pageSize), where=[], params=[]
  const keyword=String(search||'').trim().slice(0,100)
  if(keyword){where.push('(feedback.title LIKE ? OR feedback.description LIKE ? OR feedback.contact LIKE ? OR users.email LIKE ?)');params.push(...Array(4).fill(`%${keyword}%`))}
  if(type!=='all'){where.push('feedback.type = ?');params.push(String(type).slice(0,50))}
  const clause=where.length?`WHERE ${where.join(' AND ')}`:''
  const [totalRow,rows]=await Promise.all([
    queryOne(`SELECT COUNT(*) AS total FROM feedback LEFT JOIN users ON users.id=feedback.user_id ${clause}`,params),
    queryAll(`SELECT feedback.id,feedback.user_id,feedback.type,feedback.title,feedback.description,feedback.contact,feedback.created_at,
      users.nickname AS user_nickname,users.email AS user_email FROM feedback LEFT JOIN users ON users.id=feedback.user_id ${clause}
      ORDER BY feedback.id DESC LIMIT ? OFFSET ?`,[...params,paging.pageSize,(paging.page-1)*paging.pageSize]),
  ])
  const total=number(totalRow?.total)
  return {feedback:rows.map(row=>({...row,id:number(row.id),user_id:number(row.user_id)})),pagination:{page:paging.page,page_size:paging.pageSize,total,total_pages:Math.max(1,Math.ceil(total/paging.pageSize))}}
}
