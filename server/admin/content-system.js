import { queryAll, queryOne } from '../db.js'

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
    queryAll(`SELECT episode_id, number, title, description, category, content_type, duration,
      access_level, status, quiz_count, mindmap_count, knowledge_count, created_at
      FROM courses ${clause} ORDER BY created_at DESC, episode_id DESC LIMIT ? OFFSET ?`, [...params,paging.pageSize,(paging.page-1)*paging.pageSize]),
  ])
  const total=number(totalRow?.total)
  return { courses:rows.map(row=>({ ...row, id:number(row.episode_id), number:number(row.number), quiz_count:number(row.quiz_count), mindmap_count:number(row.mindmap_count), knowledge_count:number(row.knowledge_count) })), pagination:{page:paging.page,page_size:paging.pageSize,total,total_pages:Math.max(1,Math.ceil(total/paging.pageSize))} }
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
