const state = { view:'overview', profile:null, overview:null, users:[], pagination:null, search:'', membership:'all', page:1, selectedUser:null }

const icons = {
  overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  activity:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  archive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8v13H3V8M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
  chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/></svg>',
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 11 9-8 9 8v10h-6v-6H9v6H3z"/></svg>',
  menu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0 2 5M20 4v7h-7"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>',
}

document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icons[el.dataset.icon] || '' })

function token() { return localStorage.getItem('ws_token') || localStorage.getItem('authToken') || '' }
async function api(path, options = {}) {
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
  if (token()) headers.Authorization = `Bearer ${token()}`
  const response = await fetch(path, { credentials:'include', ...options, headers })
  const data = await response.json().catch(() => ({ ok:false, error:'服务器返回了无法识别的数据' }))
  if (response.status === 401) {
    location.href = `/?auth=login&next=${encodeURIComponent('/admin/')}`
    throw new Error('登录状态已失效')
  }
  if (response.status === 403) {
    location.href = '/'
    throw new Error('当前账号没有管理权限')
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || '请求失败，请稍后重试')
  return data
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))
}
function formatDate(value, withTime = false) {
  if (!value) return '未设置'
  const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('T') ? '' : '+08:00'))
  if (Number.isNaN(date.getTime())) return String(value).slice(0, withTime ? 16 : 10)
  return new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', ...(withTime ? {hour:'2-digit',minute:'2-digit'} : {}) }).format(date)
}
function planLabel(user) {
  if (user.plan === 'pro') return 'Pro 专业版'
  if (user.plan === 'plus') return 'Plus 会员'
  return '免费用户'
}
function membershipBadge(user) {
  if (user.membership_expired) return '<span class="badge expired">已过期</span>'
  if (user.plan === 'free') return '<span class="badge">免费</span>'
  return `<span class="badge ${user.plan}">${user.plan === 'pro' ? 'Pro 有效' : 'Plus 有效'}</span>`
}
function toast(message, type = '') {
  const item = document.createElement('div')
  item.className = `toast ${type}`
  item.textContent = message
  document.querySelector('#toastRegion').append(item)
  setTimeout(() => item.remove(), 4200)
}
function skeleton(count = 4) { return `<div class="metric-grid">${Array.from({length:count}, () => '<div class="skeleton"></div>').join('')}</div>` }

async function loadProfile() {
  const data = await api('/api/profile')
  const profile = data.user || data.profile || data
  if (profile.role !== 'admin') throw new Error('当前账号没有管理权限')
  state.profile = profile
  document.querySelector('#accountName').textContent = profile.nickname || profile.email || '管理员'
  document.querySelector('.account-avatar').textContent = (profile.nickname || profile.email || '管').slice(0, 1).toUpperCase()
}

function metric(label, value, note, primary = false) {
  return `<article class="metric-card ${primary ? 'is-primary' : ''}"><span class="metric-label">${label}</span><div class="metric-value">${Number(value || 0).toLocaleString('zh-CN')}</div><span class="metric-note">${note}</span></article>`
}
async function renderOverview() {
  const main = document.querySelector('#adminMain')
  main.innerHTML = `<header class="page-head"><div><span class="eyebrow">统一运营视图</span><h1>运营总览</h1><p>先看需要处理的事项，再进入对应业务模块。</p></div><button class="primary-button" data-go-users type="button">查看用户目录</button></header>${skeleton()}`
  const data = await api('/api/admin/overview')
  state.overview = data.overview
  const o = data.overview
  main.innerHTML = `
    <header class="page-head"><div><span class="eyebrow">统一运营视图</span><h1>运营总览</h1><p>先看需要处理的事项，再进入对应业务模块。</p></div><button class="primary-button" data-go-users type="button">查看用户目录</button></header>
    <section class="metric-grid" aria-label="核心运营指标">
      ${metric('用户总数',o.total_users,`今日新增 ${o.today_new_users} 人`,true)}
      ${metric('有效会员',o.plus_active + o.pro_active,`Plus ${o.plus_active} · Pro ${o.pro_active}`)}
      ${metric('当前在线',o.online_now,`今日活跃 ${o.active_today} 人`)}
      ${metric('已接入 MT5',o.connected_users,`${o.trading_accounts} 个交易账户`)}
    </section>
    <section class="content-grid">
      <article class="panel"><header class="section-head"><div><h2>需要关注</h2><p>只展示会影响用户服务或运营结果的事项。</p></div></header><div class="panel-body module-list">
        <div class="module-row"><span class="module-icon">${icons.users}</span><div><strong>已过期会员</strong><small>权限已按免费用户处理，档案仍保留原会员等级。</small></div><span class="state">${o.expired_memberships} 人</span></div>
        <div class="module-row"><span class="module-icon">${icons.activity}</span><div><strong>待处理复盘</strong><small>包含待生成、待确认及失败的周期复盘。</small></div><span class="state">${o.pending_reviews} 条</span></div>
      </div></article>
      <aside class="panel"><header class="section-head"><div><h2>迁移进度</h2><p>旧后台暂时保持可用。</p></div></header><div class="panel-body"><div class="notice">用户与会员已进入统一管理入口。AI 运营、风控审计、内容与系统配置将按业务域逐步迁移，期间不会中断现有功能。</div></div></aside>
    </section>`
  main.querySelector('[data-go-users]').addEventListener('click', () => setView('users'))
}

function userRows(users) {
  if (!users.length) return '<div class="empty-state"><div><strong>没有找到符合条件的用户</strong><p>请调整搜索词或会员状态。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table"><thead><tr><th>用户</th><th>会员状态</th><th>MT5 接入</th><th>策略</th><th>最近活跃</th><th></th></tr></thead><tbody>${users.map(user => `<tr data-user-id="${user.id}" tabindex="0"><td><div class="user-identity"><span class="user-avatar">${escapeHtml((user.nickname || user.email || '用').slice(0,1))}</span><div><strong>${escapeHtml(user.nickname || '未设置昵称')}</strong><small>${escapeHtml(user.email)}</small></div></div></td><td>${membershipBadge(user)}<div class="helper">${escapeHtml(planLabel(user))}</div></td><td>${user.bridge_connected ? '<span class="badge active">桥接在线</span>' : '<span class="badge">未连接</span>'}<div class="helper">${user.mt5_account_count} 个账户</div></td><td>${user.strategy_count} 条</td><td class="mono">${escapeHtml(formatDate(user.last_seen_at,true))}</td><td><button class="text-button" type="button" data-user-id="${user.id}">查看</button></td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${users.map(user => `<button class="mobile-user-card" type="button" data-user-id="${user.id}"><div class="mobile-user-card-head"><div class="user-identity"><span class="user-avatar">${escapeHtml((user.nickname || user.email || '用').slice(0,1))}</span><div><strong>${escapeHtml(user.nickname || '未设置昵称')}</strong><small>${escapeHtml(user.email)}</small></div></div>${membershipBadge(user)}</div><div class="mobile-user-card-meta"><span>${user.mt5_account_count} 个 MT5 账户</span><span>${user.strategy_count} 条策略</span></div></button>`).join('')}</div>`
}

async function loadUsers() {
  const params = new URLSearchParams({ page:String(state.page), page_size:'20', membership:state.membership })
  if (state.search) params.set('search', state.search)
  const data = await api(`/api/admin/users?${params}`)
  state.users = data.users
  state.pagination = data.pagination
  const list = document.querySelector('#userListArea')
  list.innerHTML = userRows(state.users)
  bindUserOpeners(list)
  const p = state.pagination
  document.querySelector('#pageLabel').textContent = `第 ${p.page} / ${p.total_pages} 页 · 共 ${p.total} 人`
  document.querySelector('#prevPage').disabled = p.page <= 1
  document.querySelector('#nextPage').disabled = p.page >= p.total_pages
}
async function renderUsers() {
  const main = document.querySelector('#adminMain')
  main.innerHTML = `
    <header class="page-head"><div><span class="eyebrow">用户与权限</span><h1>用户与会员</h1><p>会员、角色、联系方式和交易接入状态在一个档案中管理。</p></div></header>
    <section class="panel"><form class="filter-bar" id="userFilters"><div class="field"><label for="userSearch">搜索用户</label><input class="input" id="userSearch" name="search" placeholder="昵称、邮箱、手机号或用户编号" value="${escapeHtml(state.search)}"></div><div class="field"><label for="membershipFilter">会员状态</label><select class="select" id="membershipFilter"><option value="all">全部用户</option><option value="active">有效会员</option><option value="expired">已过期</option><option value="pro">Pro 专业版</option><option value="plus">Plus 会员</option><option value="free">免费用户</option></select></div><button class="secondary-button" type="submit">查询</button></form>
      <div id="userListArea">${skeleton(3)}</div>
      <footer class="pagination"><button class="secondary-button" id="prevPage" type="button">上一页</button><span id="pageLabel">正在读取…</span><button class="secondary-button" id="nextPage" type="button">下一页</button></footer>
    </section>`
  document.querySelector('#membershipFilter').value = state.membership
  document.querySelector('#userFilters').addEventListener('submit', event => { event.preventDefault(); state.search = document.querySelector('#userSearch').value.trim(); state.membership = document.querySelector('#membershipFilter').value; state.page = 1; loadUsers().catch(handleError) })
  document.querySelector('#prevPage').addEventListener('click', () => { if (state.page > 1) state.page -= 1; loadUsers().catch(handleError) })
  document.querySelector('#nextPage').addEventListener('click', () => { if (state.page < state.pagination.total_pages) state.page += 1; loadUsers().catch(handleError) })
  await loadUsers()
}

function bindUserOpeners(root) {
  root.querySelectorAll('[data-user-id]').forEach(element => element.addEventListener('click', event => { event.stopPropagation(); openUser(Number(element.dataset.userId)) }))
  root.querySelectorAll('tr[data-user-id]').forEach(row => row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') openUser(Number(row.dataset.userId)) }))
}
async function openUser(userId) {
  const layer = document.querySelector('#userModal')
  const body = document.querySelector('#userModalBody')
  layer.hidden = false
  document.body.style.overflow = 'hidden'
  body.innerHTML = skeleton(2)
  try {
    const data = await api(`/api/admin/users/${userId}`)
    state.selectedUser = data
    renderUserDetail('profile')
    layer.querySelector('[data-close-modal]').focus()
  } catch (error) { closeUserModal(); handleError(error) }
}
function renderUserDetail(tab) {
  const { user, runtime, accounts, subscriptions } = state.selectedUser
  document.querySelector('#userModalTitle').textContent = user.nickname || user.email || `用户 #${user.id}`
  const body = document.querySelector('#userModalBody')
  const hero = `<div class="detail-hero"><span class="user-avatar">${escapeHtml((user.nickname || user.email || '用').slice(0,1))}</span><div><h3>${escapeHtml(user.nickname || '未设置昵称')} ${membershipBadge(user)}</h3><p>${escapeHtml(user.email)} · ${escapeHtml(user.uid)}</p></div></div><div class="detail-tabs"><button class="detail-tab ${tab === 'profile' ? 'is-active' : ''}" data-detail-tab="profile" type="button">运营档案</button><button class="detail-tab ${tab === 'trading' ? 'is-active' : ''}" data-detail-tab="trading" type="button">交易接入</button></div>`
  if (tab === 'trading') {
    body.innerHTML = `${hero}<div class="summary-grid"><div class="summary-item"><span>自动分析</span><strong>${runtime.auto_reasoning_enabled ? '已开启' : '已关闭'}</strong></div><div class="summary-item"><span>交易发送</span><strong>${runtime.trade_send_enabled ? '已开启' : '已关闭'}</strong></div><div class="summary-item"><span>订阅策略</span><strong>${subscriptions.length} 条</strong></div></div><h3 style="margin-top:22px">MT5 账户</h3><div class="module-list">${accounts.length ? accounts.map(account => `<div class="module-row"><span class="module-icon">${icons.chart}</span><div><strong>${escapeHtml(account.mt5_login || '未知账号')} · ${escapeHtml(account.broker_server || '未知服务器')}</strong><small>${escapeHtml(account.nickname || '未设置账户名称')} · ${escapeHtml(account.observe_status || '状态未知')}</small></div></div>`).join('') : '<div class="notice">该用户尚未接入 MT5 账户。</div>'}</div>`
  } else {
    const expiry = String(user.plan_expires_at || '').slice(0,10)
    body.innerHTML = `${hero}<form id="profileForm"><div class="form-grid"><div class="field"><label for="profileNickname">昵称</label><input class="input" id="profileNickname" name="nickname" value="${escapeHtml(user.nickname)}"></div><div class="field"><label for="profileEmail">邮箱</label><input class="input" id="profileEmail" name="email" type="email" required value="${escapeHtml(user.email)}"></div><div class="field"><label for="profilePhone">手机号</label><input class="input" id="profilePhone" name="phone" type="tel" value="${escapeHtml(user.phone)}"></div><div class="field"><label for="profileRole">账号角色</label><select class="select" id="profileRole" name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></div><div class="field"><label for="profilePlan">会员等级</label><select class="select" id="profilePlan" name="plan"><option value="free">免费用户</option><option value="plus">Plus 会员</option><option value="pro">Pro 专业版</option></select></div><div class="field"><label for="profileExpiry">到期日期</label><input class="input" id="profileExpiry" name="expires_at" type="date" value="${escapeHtml(expiry)}"><span class="helper">免费用户无需设置；已过期档案仍保留原会员等级。</span></div><div class="field span-2"><label for="profilePassword">重置密码（可选）</label><input class="input" id="profilePassword" name="password" type="password" autocomplete="new-password" placeholder="至少 8 位，必须包含字母和数字"><span class="helper">保存新密码后，该用户的桥接长期登录会话会立即失效。</span></div></div><div class="form-actions"><button class="secondary-button" type="button" data-close-modal>取消</button><button class="primary-button" id="saveProfileButton" type="submit">保存档案</button></div></form>`
    body.querySelector('#profileRole').value = user.role
    body.querySelector('#profilePlan').value = user.plan
    body.querySelector('#profilePlan').addEventListener('change', event => { body.querySelector('#profileExpiry').disabled = event.target.value === 'free' })
    body.querySelector('#profileExpiry').disabled = user.plan === 'free'
    body.querySelector('#profileForm').addEventListener('submit', saveUserProfile)
    body.querySelector('[data-close-modal]').addEventListener('click', closeUserModal)
  }
  body.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => renderUserDetail(button.dataset.detailTab)))
}
async function saveUserProfile(event) {
  event.preventDefault()
  const button = document.querySelector('#saveProfileButton')
  const form = new FormData(event.currentTarget)
  const payload = Object.fromEntries(form.entries())
  if (!payload.password) delete payload.password
  if (payload.plan === 'free') payload.expires_at = ''
  button.disabled = true
  button.textContent = '正在保存…'
  try {
    await api(`/api/admin/users/${state.selectedUser.user.id}`, { method:'PATCH', body:JSON.stringify(payload) })
    toast('用户档案已保存')
    const data = await api(`/api/admin/users/${state.selectedUser.user.id}`)
    state.selectedUser = data
    renderUserDetail('profile')
    if (state.view === 'users') await loadUsers()
  } catch (error) {
    handleError(error)
    button.disabled = false
    button.textContent = '保存档案'
  }
}
function closeUserModal() {
  document.querySelector('#userModal').hidden = true
  document.body.style.overflow = ''
  state.selectedUser = null
}
function handleError(error) { toast(error?.message || '操作失败，请稍后重试', 'error') }

async function setView(view) {
  state.view = view
  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.toggle('is-active', item.dataset.view === view))
  history.replaceState({}, '', `/admin/${view === 'overview' ? '' : `?view=${view}`}`)
  document.body.classList.remove('nav-open')
  document.querySelector('#drawerScrim').hidden = true
  try {
    if (view === 'users') await renderUsers()
    else await renderOverview()
    document.querySelector('#adminMain').focus({ preventScroll:true })
  } catch (error) { handleError(error) }
}

document.querySelectorAll('.nav-item[data-view]').forEach(item => item.addEventListener('click', () => setView(item.dataset.view)))
document.querySelector('#refreshButton').addEventListener('click', () => setView(state.view))
document.querySelector('#accountButton').addEventListener('click', () => { location.href = '/profile' })
document.querySelectorAll('[data-close-modal]').forEach(item => item.addEventListener('click', closeUserModal))
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('#userModal').hidden) closeUserModal() })
document.querySelector('#mobileMenuButton').addEventListener('click', () => { const open = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', open); document.querySelector('#drawerScrim').hidden = !open; document.querySelector('#mobileMenuButton').setAttribute('aria-expanded',String(open)) })
document.querySelector('#drawerScrim').addEventListener('click', () => { document.body.classList.remove('nav-open'); document.querySelector('#drawerScrim').hidden = true })

async function bootstrap() {
  try {
    await loadProfile()
    const requested = new URLSearchParams(location.search).get('view')
    await setView(requested === 'users' ? 'users' : 'overview')
  } catch (error) { handleError(error) }
}
bootstrap()
