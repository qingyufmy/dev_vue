const state = {
  view:'overview', profile:null, overview:null, users:[], pagination:null, search:'', membership:'all', page:1, selectedUser:null,
  commercialTab:'orders', commercialOverview:null,
  orderPage:1, orderSearch:'', orderStatus:'all',
  notificationPage:1, notificationSearch:'', notificationStatus:'all', notificationChannel:'all',
  referralStatus:'all',
  aiTab:'health', aiOperations:null,
  riskTab:'status', riskData:null, riskPage:1, riskDecision:'all', auditPage:1, auditSearch:'',
  contentTab:'courses', contentOverview:null, contentPage:1, contentSearch:'', contentStatus:'all', feedbackPage:1, feedbackSearch:'',
}

const icons = {
  overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  commercial:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 15h3"/></svg>',
  activity:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 6v6c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-5"/></svg>',
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
    location.href = `/auth/login?next=${encodeURIComponent('/admin/')}`
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
function formatMoney(cents, currency = 'USD') {
  const value = Number(cents || 0) / 100
  try { return new Intl.NumberFormat('zh-CN', { style:'currency', currency:currency || 'USD', minimumFractionDigits:2 }).format(value) }
  catch { return `$${value.toFixed(2)}` }
}
const orderStatusLabels = { paid:'已完成', pending:'待支付', processing:'处理中', expired:'已过期', failed:'支付失败', cancelled:'已取消' }
const deliveryStatusLabels = { pending:'待发送', sending:'发送中', sent:'已发送', read:'已阅读', failed:'发送失败', skipped:'已跳过', cancelled:'已取消', waiting_configuration:'等待配置' }
const referralStatusLabels = { pending:'待确认', approved:'已发放', voided:'已作废', rejected:'已拒绝' }
function statusBadge(status, labels) {
  const tone = ['paid','sent','read','approved'].includes(status) ? 'active' : ['failed','expired','cancelled','voided','rejected'].includes(status) ? 'expired' : ''
  return `<span class="badge ${tone}">${escapeHtml(labels[status] || '未知状态')}</span>`
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

function commercialTabs() {
  return `<nav class="segment-tabs" aria-label="商业运营分类">
    <button type="button" class="segment-tab ${state.commercialTab === 'orders' ? 'is-active' : ''}" data-commercial-tab="orders">订单与收入</button>
    <button type="button" class="segment-tab ${state.commercialTab === 'notifications' ? 'is-active' : ''}" data-commercial-tab="notifications">到期通知</button>
    <button type="button" class="segment-tab ${state.commercialTab === 'referrals' ? 'is-active' : ''}" data-commercial-tab="referrals">返佣激励</button>
  </nav>`
}

function bindCommercialTabs() {
  document.querySelectorAll('[data-commercial-tab]').forEach(button => button.addEventListener('click', async () => {
    if (button.dataset.commercialTab === state.commercialTab) return
    state.commercialTab = button.dataset.commercialTab
    await renderCommercial()
  }))
}

function commercialMetrics(overview) {
  return `<section class="metric-grid commercial-metrics" aria-label="商业运营指标">
    <article class="metric-card is-primary"><span class="metric-label">累计实收</span><div class="metric-value money-value">${formatMoney(overview.revenue_cents)}</div><span class="metric-note">今日 ${formatMoney(overview.today_revenue_cents)}</span></article>
    ${metric('已完成订单', overview.orders_paid, `全部订单 ${overview.orders_total} 笔`)}
    ${metric('待支付订单', overview.orders_pending, `已关闭 ${overview.orders_closed} 笔`)}
    ${metric('通知异常', overview.notifications_failed, `待处理 ${overview.notifications_pending} 条`)}
  </section>`
}

async function renderCommercial() {
  const main = document.querySelector('#adminMain')
  main.innerHTML = `<header class="page-head"><div><span class="eyebrow">收入与会员触达</span><h1>商业运营</h1><p>统一查看订单收入、会员到期触达和返佣结算。</p></div></header>${skeleton()}${commercialTabs()}<section class="panel" id="commercialContent"><div class="empty-state">正在读取业务数据…</div></section>`
  bindCommercialTabs()
  const data = await api('/api/admin/commercial/overview')
  state.commercialOverview = data.overview
  const firstSkeleton = main.querySelector('.metric-grid')
  firstSkeleton.outerHTML = commercialMetrics(data.overview)
  if (state.commercialTab === 'notifications') await renderCommercialNotifications()
  else if (state.commercialTab === 'referrals') await renderCommercialReferrals()
  else await renderCommercialOrders()
}

function orderRows(orders) {
  if (!orders.length) return '<div class="empty-state"><div><strong>没有符合条件的订单</strong><p>调整订单状态或搜索条件后再试。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>订单</th><th>用户</th><th>方案</th><th>订单金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${orders.map(order => `<tr><td><strong>${escapeHtml(order.order_no || order.order_id)}</strong><div class="helper">${escapeHtml(order.payment_method || '未选择支付方式')}</div></td><td><strong>${escapeHtml(order.user_name || order.user_uid || `用户 #${order.user_id}`)}</strong><div class="helper">${escapeHtml(order.user_email)}</div></td><td>${escapeHtml(order.plan_label || order.plan)}<div class="helper">${escapeHtml(order.period_label || order.period)}</div></td><td class="mono amount-cell">${formatMoney(order.status === 'paid' ? order.confirmed_cents : order.amount_cents, order.currency)}</td><td>${statusBadge(order.status, orderStatusLabels)}</td><td class="mono">${escapeHtml(formatDate(order.created_at, true))}</td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${orders.map(order => `<article class="mobile-user-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(order.order_no || order.order_id)}</strong><div class="helper">${escapeHtml(order.user_name || order.user_email || `用户 #${order.user_id}`)}</div></div>${statusBadge(order.status, orderStatusLabels)}</div><div class="mobile-business-grid"><span>方案<strong>${escapeHtml(order.plan_label || order.plan)}</strong></span><span>订单金额<strong>${formatMoney(order.status === 'paid' ? order.confirmed_cents : order.amount_cents, order.currency)}</strong></span><span>创建时间<strong>${escapeHtml(formatDate(order.created_at, true))}</strong></span></div></article>`).join('')}</div>`
}

async function loadCommercialOrders() {
  const params = new URLSearchParams({ page:String(state.orderPage), page_size:'20', status:state.orderStatus })
  if (state.orderSearch) params.set('search', state.orderSearch)
  const data = await api(`/api/admin/commercial/orders?${params}`)
  document.querySelector('#businessListArea').innerHTML = orderRows(data.orders)
  document.querySelector('#businessPageLabel').textContent = `第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 笔`
  document.querySelector('#businessPrevPage').disabled = data.pagination.page <= 1
  document.querySelector('#businessNextPage').disabled = data.pagination.page >= data.pagination.total_pages
  document.querySelector('#businessPrevPage').onclick = () => { state.orderPage -= 1; loadCommercialOrders().catch(handleError) }
  document.querySelector('#businessNextPage').onclick = () => { state.orderPage += 1; loadCommercialOrders().catch(handleError) }
}

async function renderCommercialOrders() {
  const content = document.querySelector('#commercialContent')
  content.innerHTML = `<form class="filter-bar" id="orderFilters"><div class="field"><label for="orderSearch">搜索订单</label><input class="input" id="orderSearch" placeholder="订单号、用户编号、昵称或邮箱" value="${escapeHtml(state.orderSearch)}"></div><div class="field"><label for="orderStatus">订单状态</label><select class="select" id="orderStatus"><option value="all">全部状态</option><option value="paid">已完成</option><option value="pending">待支付</option><option value="processing">处理中</option><option value="failed">支付失败</option><option value="expired">已过期</option><option value="cancelled">已取消</option></select></div><button class="secondary-button" type="submit">查询</button></form><div id="businessListArea">${skeleton(3)}</div><footer class="pagination"><button class="secondary-button" id="businessPrevPage" type="button">上一页</button><span id="businessPageLabel">正在读取…</span><button class="secondary-button" id="businessNextPage" type="button">下一页</button></footer>`
  content.querySelector('#orderStatus').value = state.orderStatus
  content.querySelector('#orderFilters').addEventListener('submit', event => { event.preventDefault(); state.orderSearch = content.querySelector('#orderSearch').value.trim(); state.orderStatus = content.querySelector('#orderStatus').value; state.orderPage = 1; loadCommercialOrders().catch(handleError) })
  await loadCommercialOrders()
}

function notificationRows(records) {
  if (!records.length) return '<div class="empty-state"><div><strong>没有符合条件的通知</strong><p>当前筛选条件下没有发送记录。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>用户</th><th>提醒节点</th><th>渠道</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>${records.map(record => `<tr><td><strong>${escapeHtml(record.nickname || `用户 #${record.user_id}`)}</strong><div class="helper">${escapeHtml(record.email || record.phone || '未配置联系方式')}</div></td><td>${Number(record.days_before) === 0 ? '会员已过期' : `到期前 ${Number(record.days_before)} 天`}<div class="helper">${escapeHtml(String(record.plan || '').toUpperCase())}</div></td><td>${record.channel === 'sms' ? '短信' : record.channel === 'email' ? '邮件' : '网页弹窗'}</td><td>${statusBadge(record.delivery_state, deliveryStatusLabels)}${record.error_text ? `<div class="error-helper">${escapeHtml(record.error_text)}</div>` : ''}</td><td class="mono">${escapeHtml(formatDate(record.updated_at, true))}</td><td>${record.retry_allowed ? `<button class="text-button" type="button" data-retry-notification="${record.id}">重试</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${records.map(record => `<article class="mobile-user-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(record.nickname || `用户 #${record.user_id}`)}</strong><div class="helper">${record.channel === 'sms' ? '短信' : record.channel === 'email' ? '邮件' : '网页弹窗'} · ${Number(record.days_before) === 0 ? '会员已过期' : `到期前 ${Number(record.days_before)} 天`}</div></div>${statusBadge(record.delivery_state, deliveryStatusLabels)}</div>${record.error_text ? `<p class="error-helper">${escapeHtml(record.error_text)}</p>` : ''}${record.retry_allowed ? `<button class="secondary-button compact-action" type="button" data-retry-notification="${record.id}">重新发送</button>` : ''}</article>`).join('')}</div>`
}

async function loadCommercialNotifications() {
  const params = new URLSearchParams({ page:String(state.notificationPage), page_size:'10' })
  if (state.notificationSearch) params.set('search', state.notificationSearch)
  if (state.notificationStatus !== 'all') params.set('status', state.notificationStatus)
  if (state.notificationChannel !== 'all') params.set('channel', state.notificationChannel)
  const data = await api(`/api/admin/membership-expiry-notifications?${params}`)
  document.querySelector('#businessListArea').innerHTML = notificationRows(data.records)
  document.querySelector('#providerState').innerHTML = `<span class="provider-dot ${data.providerConfigured.email ? 'ok' : ''}"></span>邮件 ${data.providerConfigured.email ? '已配置' : '未配置'}<span class="provider-dot ${data.providerConfigured.sms ? 'ok' : ''}"></span>短信 ${data.providerConfigured.sms ? '已配置' : '未完整配置'}`
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))
  document.querySelector('#businessPageLabel').textContent = `第 ${data.page} / ${totalPages} 页 · 共 ${data.total} 条`
  document.querySelector('#businessPrevPage').disabled = data.page <= 1
  document.querySelector('#businessNextPage').disabled = data.page >= totalPages
  document.querySelector('#businessPrevPage').onclick = () => { state.notificationPage -= 1; loadCommercialNotifications().catch(handleError) }
  document.querySelector('#businessNextPage').onclick = () => { state.notificationPage += 1; loadCommercialNotifications().catch(handleError) }
  document.querySelectorAll('[data-retry-notification]').forEach(button => button.addEventListener('click', async () => {
    if (!await confirmAction('重新发送到期通知', '系统会立即重新尝试该用户的通知渠道，请确认联系方式和服务商配置已经恢复。')) return
    try { await api(`/api/admin/membership-expiry-notifications/${button.dataset.retryNotification}/retry`, { method:'POST' }); toast('通知已进入重试队列'); await loadCommercialNotifications() } catch (error) { handleError(error) }
  }))
}

async function renderCommercialNotifications() {
  const content = document.querySelector('#commercialContent')
  content.innerHTML = `<div class="provider-state" id="providerState">正在检查通知渠道…</div><form class="filter-bar wide-filter" id="notificationFilters"><div class="field"><label for="notificationSearch">搜索用户</label><input class="input" id="notificationSearch" placeholder="昵称、邮箱、手机号或用户编号" value="${escapeHtml(state.notificationSearch)}"></div><div class="field"><label for="notificationChannel">发送渠道</label><select class="select" id="notificationChannel"><option value="all">全部渠道</option><option value="web">网页弹窗</option><option value="email">邮件</option><option value="sms">短信</option></select></div><div class="field"><label for="notificationStatus">发送状态</label><select class="select" id="notificationStatus"><option value="all">全部状态</option><option value="pending">待发送</option><option value="sent">已发送</option><option value="read">已阅读</option><option value="failed">发送失败</option><option value="skipped">已跳过</option><option value="cancelled">已取消</option></select></div><button class="secondary-button" type="submit">查询</button></form><div id="businessListArea">${skeleton(3)}</div><footer class="pagination"><button class="secondary-button" id="businessPrevPage" type="button">上一页</button><span id="businessPageLabel">正在读取…</span><button class="secondary-button" id="businessNextPage" type="button">下一页</button></footer>`
  content.querySelector('#notificationChannel').value = state.notificationChannel
  content.querySelector('#notificationStatus').value = state.notificationStatus
  content.querySelector('#notificationFilters').addEventListener('submit', event => { event.preventDefault(); state.notificationSearch = content.querySelector('#notificationSearch').value.trim(); state.notificationChannel = content.querySelector('#notificationChannel').value; state.notificationStatus = content.querySelector('#notificationStatus').value; state.notificationPage = 1; loadCommercialNotifications().catch(handleError) })
  await loadCommercialNotifications()
}

function referralRows(commissions) {
  if (!commissions.length) return '<div class="empty-state"><div><strong>暂无返佣记录</strong><p>当前筛选条件下没有待处理事项。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>邀请人</th><th>受邀用户</th><th>来源订单</th><th>返佣金额</th><th>状态</th><th></th></tr></thead><tbody>${commissions.map(item => `<tr><td><strong>${escapeHtml(item.referrer?.name || item.referrer?.uid || '未知用户')}</strong><div class="helper">${escapeHtml(item.referrer?.email)}</div></td><td>${escapeHtml(item.invited_user?.name || item.invited_user?.uid || '未知用户')}<div class="helper">${escapeHtml(item.invited_user?.email)}</div></td><td>${escapeHtml(item.order_id || '尚未关联订单')}<div class="helper">${escapeHtml([item.plan,item.period].filter(Boolean).join(' · '))}</div></td><td class="mono amount-cell">${formatMoney(item.amount_cents)}</td><td>${statusBadge(item.status, referralStatusLabels)}</td><td>${item.status === 'pending' ? `<div class="row-actions"><button class="text-button" type="button" data-referral-action="approve" data-referral-id="${item.id}">确认发放</button><button class="text-button danger-text" type="button" data-referral-action="void" data-referral-id="${item.id}">作废</button></div>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${commissions.map(item => `<article class="mobile-user-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(item.referrer?.name || item.referrer?.uid || '未知用户')}</strong><div class="helper">邀请 ${escapeHtml(item.invited_user?.name || item.invited_user?.uid || '未知用户')}</div></div>${statusBadge(item.status, referralStatusLabels)}</div><div class="mobile-business-grid"><span>返佣金额<strong>${formatMoney(item.amount_cents)}</strong></span><span>来源订单<strong>${escapeHtml(item.order_id || '未关联')}</strong></span></div>${item.status === 'pending' ? `<div class="mobile-actions"><button class="secondary-button" type="button" data-referral-action="void" data-referral-id="${item.id}">作废</button><button class="primary-button" type="button" data-referral-action="approve" data-referral-id="${item.id}">确认发放</button></div>` : ''}</article>`).join('')}</div>`
}

async function loadCommercialReferrals() {
  const params = new URLSearchParams()
  if (state.referralStatus !== 'all') params.set('status', state.referralStatus)
  const [overview, data] = await Promise.all([api('/api/admin/referrals/overview'), api(`/api/admin/referrals/commissions?${params}`)])
  document.querySelector('#referralSummary').innerHTML = `<span>累计邀请 <strong>${Number(overview.total || 0).toLocaleString('zh-CN')}</strong></span><span>待确认 <strong>${Number(overview.pending || 0).toLocaleString('zh-CN')}</strong></span><span>已发放 <strong>${formatMoney(overview.stats?.available_credit_cents || overview.totalCommission || 0)}</strong></span>`
  document.querySelector('#businessListArea').innerHTML = referralRows(data.commissions || [])
  document.querySelectorAll('[data-referral-action]').forEach(button => button.addEventListener('click', async () => {
    const approve = button.dataset.referralAction === 'approve'
    const title = approve ? '确认发放返佣' : '确认作废返佣'
    const message = approve ? '确认后，返佣金额会计入邀请人的可用余额。该操作不能重复执行。' : '作废后，该条返佣金额将清零，请确认订单确实不符合返佣条件。'
    if (!await confirmAction(title, message, approve ? '确认发放' : '确认作废', !approve)) return
    try { await api(`/api/admin/referrals/commissions/${button.dataset.referralId}`, { method:'PATCH', body:JSON.stringify({ action:button.dataset.referralAction }) }); toast(approve ? '返佣已发放' : '返佣已作废'); await loadCommercialReferrals() } catch (error) { handleError(error) }
  }))
}

async function renderCommercialReferrals() {
  const content = document.querySelector('#commercialContent')
  content.innerHTML = `<div class="referral-summary" id="referralSummary"><span>正在读取返佣数据…</span></div><form class="filter-bar compact-filter" id="referralFilters"><div class="field"><label for="referralStatus">结算状态</label><select class="select" id="referralStatus"><option value="all">全部状态</option><option value="pending">待确认</option><option value="approved">已发放</option><option value="voided">已作废</option></select></div><button class="secondary-button" type="submit">查询</button></form><div id="businessListArea">${skeleton(3)}</div>`
  content.querySelector('#referralStatus').value = state.referralStatus
  content.querySelector('#referralFilters').addEventListener('submit', event => { event.preventDefault(); state.referralStatus = content.querySelector('#referralStatus').value; loadCommercialReferrals().catch(handleError) })
  await loadCommercialReferrals()
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
function confirmAction(title, message, confirmLabel = '确认', danger = false) {
  const layer = document.querySelector('#confirmModal')
  const button = document.querySelector('#confirmModalButton')
  document.querySelector('#confirmModalTitle').textContent = title
  document.querySelector('#confirmModalMessage').textContent = message
  button.textContent = confirmLabel
  button.classList.toggle('danger-button', danger)
  layer.hidden = false
  document.body.style.overflow = 'hidden'
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      layer.hidden = true
      document.body.style.overflow = ''
      button.removeEventListener('click', accept)
      layer.querySelectorAll('[data-cancel-confirm]').forEach(item => item.removeEventListener('click', cancel))
      resolve(value)
    }
    const accept = () => finish(true)
    const cancel = () => finish(false)
    button.addEventListener('click', accept)
    layer.querySelectorAll('[data-cancel-confirm]').forEach(item => item.addEventListener('click', cancel))
    button.focus()
  })
}
function handleError(error) { toast(error?.message || '操作失败，请稍后重试', 'error') }

const schedulerReasonLabels = {
  cooldown:'冷却期内', admin_bridge_offline:'管理员桥接离线', market_closed:'市场休市',
  market_restricted:'交易权限受限', market_stale_tick:'行情报价停滞', market_unknown:'市场状态未知',
  redis_unavailable:'缓存服务不可用', weekly_flatten_window:'周末清仓时段', no_api_key:'模型密钥未配置',
  strategy_disabled:'策略已停用', user_bridge_offline:'用户桥接离线', owner_bridge_offline:'观摩源桥接离线',
  lock_busy:'等待上一轮调度结束', redis_error:'缓存服务通信异常', finalize_failed:'调度状态恢复中',
}
function schedulerReason(reason, error = false) {
  const code = String(reason || '').trim()
  return schedulerReasonLabels[code] || (error ? '调度运行异常，请查看服务日志' : '等待运行条件恢复')
}
function percent(success, total) {
  return Number(total) > 0 ? `${Math.max(0, Number(success) / Number(total) * 100).toFixed(1)}%` : '100%'
}
function aiTabs() {
  return `<nav class="segment-tabs" aria-label="AI 运营治理分类">
    <button type="button" class="segment-tab ${state.aiTab === 'health' ? 'is-active' : ''}" data-ai-tab="health">运行健康</button>
    <button type="button" class="segment-tab ${state.aiTab === 'scheduler' ? 'is-active' : ''}" data-ai-tab="scheduler">调度与模型</button>
    <button type="button" class="segment-tab ${state.aiTab === 'observer' ? 'is-active' : ''}" data-ai-tab="observer">观摩频道</button>
  </nav>`
}
function bindAiTabs() {
  document.querySelectorAll('[data-ai-tab]').forEach(button => button.addEventListener('click', () => {
    state.aiTab = button.dataset.aiTab
    renderAiOperationsContent()
  }))
}
function aiHealthContent(data) {
  const summary = data.summary
  const requests = Number(summary.model_requests_today || 0)
  const failures = Number(summary.model_failures_today || 0)
  const alerts = Array.isArray(data.rollout?.alerts) ? data.rollout.alerts : []
  const pendingReviews = (data.review_health?.cases || []).filter(item => ['draft','edited','ready','generating'].includes(item.status)).reduce((sum, item) => sum + Number(item.case_count || 0), 0)
  const failedReviews = (data.review_health?.cases || []).filter(item => item.status === 'failed').reduce((sum, item) => sum + Number(item.case_count || 0), 0)
  const healthy = failures === 0 && alerts.length === 0 && failedReviews === 0
  return `<section class="health-banner ${healthy ? 'is-healthy' : 'needs-attention'}">
      <span class="health-mark">${healthy ? '✓' : '!'}</span><div><span class="eyebrow">平台运行结论</span><h2>${healthy ? 'AI 核心链路运行正常' : '存在需要处理的运行事项'}</h2><p>${healthy ? '模型、调度与复盘链路未发现阻断性异常。' : `模型失败 ${failures} 次，治理告警 ${alerts.length} 项，失败复盘 ${failedReviews} 条。`}</p></div>
    </section>
    <section class="content-grid ai-health-grid">
      <article class="panel"><header class="section-head"><div><h2>今日核心链路</h2><p>只保留影响推理和交易交付的关键指标。</p></div></header><div class="panel-body compact-facts">
        <div><span>模型成功率</span><strong>${percent(requests - failures, requests)}</strong><small>${requests} 次请求</small></div>
        <div><span>平均模型响应</span><strong>${summary.avg_model_latency_ms ? `${(summary.avg_model_latency_ms / 1000).toFixed(1)} 秒` : '--'}</strong><small>成功请求</small></div>
        <div><span>今日推理信号</span><strong>${Number(summary.signals_today || 0)}</strong><small>${Number(summary.signal_errors_today || 0)} 条异常</small></div>
        <div><span>在线桥接</span><strong>${Number(summary.connected_bridges || 0)}</strong><small>90 秒内活跃</small></div>
      </div></article>
      <article class="panel"><header class="section-head"><div><h2>待处理事项</h2><p>正常风控拒绝不会被误判为系统故障。</p></div></header><div class="panel-body attention-stack">
        ${alerts.length ? alerts.map(item => `<div class="attention-row"><span class="badge expired">${item.severity === 'critical' ? '紧急' : '关注'}</span><div><strong>${item.code === 'uncertain_order_age' ? '存在长期未确认订单' : item.code === 'review_jobs_failed' ? '复盘任务生成失败' : item.code === 'memory_compression_stale' ? '记忆压缩任务积压' : 'AI 治理任务异常'}</strong><small>系统值：${Number(item.value || 0)}</small></div></div>`).join('') : '<div class="empty-inline">当前没有治理告警</div>'}
        <div class="attention-row"><span class="badge ${failedReviews ? 'expired' : 'active'}">复盘</span><div><strong>${pendingReviews} 条待处理，${failedReviews} 条失败</strong><small>按最新有效版本统计</small></div></div>
        <div class="attention-row"><span class="badge">风控</span><div><strong>今日正常拒绝 ${Number(summary.risk_rejections_today || 0)} 次</strong><small>用于观察规则命中，不计入系统故障</small></div></div>
      </div></article>
    </section>`
}
function schedulerCards(data) {
  const runtime = data.scheduler?.runtime || []
  const configured = data.scheduler?.configured || []
  if (!runtime.length && !configured.length) return '<div class="empty-state"><div><strong>当前没有启用的自动分析调度</strong><p>启用策略订阅后，运行状态会出现在这里。</p></div></div>'
  const runtimeIds = new Set(runtime.map(item => Number(item.strategy_id)))
  const cards = runtime.map(item => {
    const stateText = item.in_flight ? '正在分析' : item.last_error ? '运行异常' : item.wait_reason ? '等待条件' : item.running ? '等待下一轮' : '已停止'
    const tone = item.last_error ? 'expired' : item.in_flight || (item.running && !item.wait_reason) ? 'active' : ''
    const reason = item.last_error ? schedulerReason(item.last_error, true) : item.wait_reason ? schedulerReason(item.wait_reason) : '运行状态正常'
    return `<article class="runtime-card"><header><div><strong>${escapeHtml(item.strategy_name || `策略 #${item.strategy_id}`)}</strong><small>${escapeHtml(item.symbol || '--')} · 每 ${Number(item.interval_minutes || 5)} 分钟</small></div><span class="badge ${tone}">${stateText}</span></header><div class="runtime-facts"><span>订阅用户<strong>${Number(item.subscriber_count || 0)}</strong></span><span>下次运行<strong>${item.next_run_in_seconds > 0 ? `${item.next_run_in_seconds} 秒` : '--'}</strong></span></div><p>${escapeHtml(reason)}</p></article>`
  })
  configured.filter(item => !runtimeIds.has(Number(item.strategy_id))).forEach(item => cards.push(`<article class="runtime-card"><header><div><strong>${escapeHtml(item.strategy_name || `策略 #${item.strategy_id}`)}</strong><small>每 ${Number(item.interval_minutes || 5)} 分钟</small></div><span class="badge">等待实例</span></header><div class="runtime-facts"><span>订阅用户<strong>${Number(item.subscriber_count || 0)}</strong></span><span>运行实例<strong>未启动</strong></span></div><p>等待桥接或调度条件满足</p></article>`))
  return `<div class="runtime-grid">${cards.join('')}</div>`
}
function aiSchedulerContent(data) {
  const rows = data.model_usage || []
  return `<section class="panel"><header class="section-head"><div><h2>自动分析调度</h2><p>${data.scheduler?.runtime_available ? '显示实时调度状态与等待原因。' : '实时缓存暂不可用，当前显示数据库配置。'}</p></div><span class="badge ${data.scheduler?.runtime_available ? 'active' : 'expired'}">${data.scheduler?.runtime_available ? '实时数据' : '降级数据'}</span></header>${schedulerCards(data)}</section>
    <section class="panel section-gap"><header class="section-head"><div><h2>模型调用质量</h2><p>最近 24 小时按模型统计成功率、耗时和消耗。</p></div></header>
      ${rows.length ? `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>模型</th><th>调用</th><th>成功率</th><th>平均响应</th><th>令牌消耗</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.model_name || '未命名模型')}</strong><div class="helper">${escapeHtml(row.credential_source || '未知来源')}</div></td><td class="mono">${row.requests}</td><td>${percent(row.requests - row.failures, row.requests)}</td><td>${row.avg_latency_ms ? `${(row.avg_latency_ms / 1000).toFixed(1)} 秒` : '--'}</td><td class="mono">${Number(row.tokens || 0).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table></div><div class="mobile-user-list">${rows.map(row => `<article class="mobile-user-card"><div class="mobile-user-card-head"><strong>${escapeHtml(row.model_name || '未命名模型')}</strong><span class="badge ${row.failures ? 'expired' : 'active'}">${percent(row.requests - row.failures, row.requests)}</span></div><div class="mobile-business-grid"><span>调用<strong>${row.requests}</strong></span><span>平均响应<strong>${row.avg_latency_ms ? `${(row.avg_latency_ms / 1000).toFixed(1)} 秒` : '--'}</strong></span><span>令牌<strong>${Number(row.tokens || 0).toLocaleString('zh-CN')}</strong></span></div></article>`).join('')}</div>` : '<div class="empty-state">最近 24 小时没有模型调用记录</div>'}
    </section>`
}
function audienceLabel(value) { return ({all:'全部用户',plus:'Plus 用户',pro:'Pro 用户',assigned:'指定用户'})[value] || '未设置' }
function aiObserverContent(data) {
  const sources = data.observer?.sources || []
  const channels = data.observer?.channels || []
  return `<section class="observer-admin-grid"><article class="panel"><header class="section-head"><div><h2>观摩源</h2><p>直接控制每个来源是否自动分析、是否发送交易。</p></div><span class="badge">${sources.length} 个</span></header><div class="observer-stack">${sources.length ? sources.map(source => `<article class="observer-source-row"><div class="observer-source-title"><span class="provider-dot ${source.bridge_online ? 'ok' : ''}"></span><div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.strategy_title || '未绑定策略')} · ${source.bridge_online ? '桥接在线' : '桥接离线'}</small></div></div><div class="runtime-switches"><label><input type="checkbox" data-source-toggle="auto" data-source-id="${Number(source.id)}" ${Number(source.auto_inference_enabled) ? 'checked' : ''}><span>自动分析</span></label><label><input type="checkbox" data-source-toggle="trade" data-source-id="${Number(source.id)}" ${Number(source.trade_send_enabled) ? 'checked' : ''}><span>交易发送</span></label></div></article>`).join('') : '<div class="empty-state">还没有配置观摩源</div>'}</div></article>
    <article class="panel"><header class="section-head"><div><h2>频道分发</h2><p>查看默认频道、开放范围与来源状态。</p></div><span class="badge">${channels.length} 个</span></header><div class="observer-stack">${channels.length ? channels.map(channel => `<article class="channel-row"><div><div class="channel-name"><strong>${escapeHtml(channel.name)}</strong>${Number(channel.is_default) ? '<span class="badge active">默认</span>' : ''}</div><small>${escapeHtml(channel.source_name || '未绑定来源')} · ${audienceLabel(channel.audience)}</small></div><span class="badge ${channel.status === 'active' && channel.source_status === 'active' ? 'active' : 'expired'}">${channel.status === 'active' && channel.source_status === 'active' ? '可用' : '停用'}</span></article>`).join('') : '<div class="empty-state">还没有配置观摩频道</div>'}</div></article></section>`
}
function bindObserverRuntime() {
  document.querySelectorAll('[data-source-toggle]').forEach(input => input.addEventListener('change', async () => {
    const source = state.aiOperations.observer.sources.find(item => Number(item.id) === Number(input.dataset.sourceId))
    if (!source) return
    input.disabled = true
    const nextAuto = input.dataset.sourceToggle === 'auto' ? input.checked : Boolean(Number(source.auto_inference_enabled))
    const nextTrade = input.dataset.sourceToggle === 'trade' ? input.checked : Boolean(Number(source.trade_send_enabled))
    try {
      await api(`/api/admin/ai/observer-sources/${source.id}/runtime`, { method:'PATCH', body:JSON.stringify({ auto_inference_enabled:nextAuto, trade_send_enabled:nextTrade }) })
      toast('观摩源运行设置已更新', 'success')
      await loadAiOperations(true)
    } catch (error) { input.checked = !input.checked; handleError(error) }
    finally { input.disabled = false }
  }))
}
function renderAiOperationsContent() {
  const content = document.querySelector('#aiOperationsContent')
  if (!content || !state.aiOperations) return
  if (state.aiTab === 'scheduler') content.innerHTML = aiSchedulerContent(state.aiOperations)
  else if (state.aiTab === 'observer') content.innerHTML = aiObserverContent(state.aiOperations)
  else content.innerHTML = aiHealthContent(state.aiOperations)
  document.querySelectorAll('[data-ai-tab]').forEach(button => button.classList.toggle('is-active', button.dataset.aiTab === state.aiTab))
  if (state.aiTab === 'observer') bindObserverRuntime()
}
async function loadAiOperations(silent = false) {
  if (!silent) document.querySelector('#aiOperationsContent').innerHTML = '<div class="panel"><div class="empty-state">正在汇总 AI 运行数据…</div></div>'
  const data = await api('/api/admin/ai/overview')
  state.aiOperations = data.operations
  renderAiOperationsContent()
}
async function renderAiOperations() {
  const main = document.querySelector('#adminMain')
  main.innerHTML = `<header class="page-head"><div><span class="eyebrow">模型、调度与观摩分发</span><h1>AI 运营治理</h1><p>先确认核心链路是否健康，再处理调度、模型和观摩频道。</p></div><a class="secondary-button" href="/ai/?tab=admin-dashboard">打开旧版高级工具</a></header>${aiTabs()}<div id="aiOperationsContent"></div>`
  bindAiTabs()
  await loadAiOperations()
}

function riskTabs() { return `<nav class="segment-tabs" aria-label="风控与审计分类"><button class="segment-tab ${state.riskTab === 'status' ? 'is-active' : ''}" data-risk-tab="status" type="button">风险状态</button><button class="segment-tab ${state.riskTab === 'decisions' ? 'is-active' : ''}" data-risk-tab="decisions" type="button">执行决策</button><button class="segment-tab ${state.riskTab === 'audit' ? 'is-active' : ''}" data-risk-tab="audit" type="button">管理审计</button></nav>` }
function accountRiskStatus(account) {
  const stopped = account.user_kill_switch || account.halt_status && account.halt_status !== 'active' || !account.data_complete
  const reason = account.user_kill_switch ? '账户紧急停止已开启' : !account.data_complete ? (account.data_incomplete_reason || '风控数据尚不完整') : account.halt_status && account.halt_status !== 'active' ? (account.halt_reason || '账户已暂停新开仓') : '当前允许交易'
  return `<article class="risk-account-row"><span class="health-mark ${stopped ? 'risk-stop' : ''}">${stopped ? '!' : '✓'}</span><div class="risk-account-main"><div><strong>${escapeHtml(account.nickname || account.login_account)}</strong><span class="badge ${stopped ? 'expired' : 'active'}">${stopped ? '已暂停' : '允许交易'}</span></div><small>${escapeHtml(account.user_nickname || account.user_email)} · ${escapeHtml(reason)}</small><div class="risk-account-facts"><span>回撤 <b>${account.drawdown_pct ?? '--'}%</b></span><span>连亏 <b>${account.consecutive_losses ?? '--'}</b></span><span>数据 <b>${account.data_complete ? '完整' : '不完整'}</b></span></div></div></article>`
}
function riskStatusContent(data) {
  const s = data.summary, global = data.global_control
  return `<section class="health-banner ${global.global_kill_switch ? 'needs-attention' : 'is-healthy'}"><span class="health-mark ${global.global_kill_switch ? 'risk-stop' : ''}">${global.global_kill_switch ? '!' : '✓'}</span><div><span class="eyebrow">平台交易总闸门</span><h2>${global.global_kill_switch ? '平台已暂停所有新开仓' : '平台交易总闸门正常'}</h2><p>${global.global_kill_switch ? escapeHtml(global.reason || '管理员已开启紧急停止') : '账户仍会分别接受自身风控规则检查。'}</p></div><div class="stop-action">${global.global_kill_switch ? '' : '<input class="input" id="globalStopReason" maxlength="120" placeholder="填写停止原因（至少 4 个字）">'}<button class="${global.global_kill_switch ? 'secondary-button' : 'danger-button primary-button'}" data-global-stop type="button">${global.global_kill_switch ? '解除紧急停止' : '紧急停止新开仓'}</button></div></section><section class="metric-grid">${metric('今日风控决策',s.decisions_today,`${s.adjusted_today} 次调整`,true)}${metric('今日拒绝',s.rejected_today,'正常规则命中')}${metric('暂停账户',s.paused_accounts,`共 ${s.trading_accounts} 个账户`)}${metric('管理操作',s.admin_actions_today,'今日审计记录')}</section><section class="panel"><header class="section-head"><div><h2>账户风险状态</h2><p>优先展示暂停、数据不完整和紧急停止账户。</p></div></header><div class="risk-account-list">${data.accounts.map(accountRiskStatus).join('') || '<div class="empty-state">暂无交易账户</div>'}</div></section>`
}
function riskDecisionsContent(data) {
  return `<section class="panel"><form class="filter-bar compact-filter" id="riskDecisionFilter"><div class="field"><label for="riskDecision">决策结果</label><select class="select" id="riskDecision"><option value="all">全部结果</option><option value="pass">通过</option><option value="adjust">调整后通过</option><option value="reject">拒绝</option></select></div><button class="secondary-button" type="submit">筛选</button></form><div class="decision-list">${data.decisions.map(item => `<article class="decision-row"><div><strong>#${item.id} · ${escapeHtml(item.symbol || '--')}</strong><small>${escapeHtml(item.user_nickname || item.user_email || `用户 #${item.user_id}`)} · ${formatDate(item.created_at,true)}</small></div><div class="decision-reason"><span class="badge ${item.decision_status === 'reject' ? 'expired' : 'active'}">${item.decision_status === 'reject' ? '拒绝' : item.decision_status === 'adjust' ? '调整后通过' : '通过'}</span><p>${escapeHtml(item.reason || '风控检查已完成')}</p></div></article>`).join('') || '<div class="empty-state">没有符合条件的风控决策</div>'}</div><div class="pagination"><button class="secondary-button" id="riskPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="riskNext" type="button">下一页</button></div></section>`
}
async function loadRiskAudit() {
  const params = new URLSearchParams({page:String(state.riskPage),page_size:'20',decision:state.riskDecision})
  const data = await api(`/api/admin/risk-audit/overview?${params}`); state.riskData = data; renderRiskContent()
}
async function renderAuditEvents() {
  const params = new URLSearchParams({page:String(state.auditPage),page_size:'20'}); if(state.auditSearch) params.set('search',state.auditSearch)
  const data = await api(`/api/admin/risk-audit/admin-events?${params}`)
  document.querySelector('#riskContent').innerHTML = `<section class="panel"><form class="filter-bar compact-filter" id="auditSearchForm"><div class="field"><label for="auditSearch">搜索操作记录</label><input class="input" id="auditSearch" value="${escapeHtml(state.auditSearch)}" placeholder="管理员、动作或详情"></div><button class="secondary-button" type="submit">搜索</button></form><div class="decision-list">${data.events.map(item=>`<article class="decision-row"><div><strong>${escapeHtml(item.action_label)}</strong><small>${escapeHtml(item.user_nickname || item.user_email || `管理员 #${item.user_id}`)} · ${formatDate(item.created_at,true)}</small></div><div class="decision-reason"><span class="badge">${escapeHtml(item.target_type || '系统')}</span><p>${escapeHtml(item.detail || '已记录操作')}</p></div></article>`).join('') || '<div class="empty-state">暂无管理操作记录</div>'}</div><div class="pagination"><button class="secondary-button" id="auditPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="auditNext" type="button">下一页</button></div></section>`
  document.querySelector('#auditSearchForm').onsubmit=e=>{e.preventDefault();state.auditSearch=document.querySelector('#auditSearch').value.trim();state.auditPage=1;renderAuditEvents().catch(handleError)}
  document.querySelector('#auditPrev').disabled=data.pagination.page<=1; document.querySelector('#auditNext').disabled=data.pagination.page>=data.pagination.total_pages
  document.querySelector('#auditPrev').onclick=()=>{state.auditPage--;renderAuditEvents().catch(handleError)};document.querySelector('#auditNext').onclick=()=>{state.auditPage++;renderAuditEvents().catch(handleError)}
}
function bindRiskStatus() {
  const stop=document.querySelector('[data-global-stop]'); if(!stop)return
  stop.onclick=async()=>{const enabled=!state.riskData.global_control.global_kill_switch;const reason=enabled?(document.querySelector('#globalStopReason')?.value.trim()||''):'';if(enabled&&reason.length<4){toast('请先填写至少 4 个字的停止原因','error');document.querySelector('#globalStopReason')?.focus();return} if(!await confirmAction(enabled?'开启平台紧急停止':'解除平台紧急停止',enabled?'开启后所有账户都不能新增仓位。':'解除后各账户仍会继续接受自身风控检查。',enabled?'确认停止':'确认解除',enabled))return;try{await api('/api/admin/risk-audit/global-stop',{method:'POST',body:JSON.stringify({enabled,reason})});toast('平台紧急停止状态已更新','success');await loadRiskAudit()}catch(error){handleError(error)}}
}
function renderRiskContent(){const root=document.querySelector('#riskContent');if(!root||!state.riskData)return;if(state.riskTab==='decisions')root.innerHTML=riskDecisionsContent(state.riskData);else root.innerHTML=riskStatusContent(state.riskData);if(state.riskTab==='status')bindRiskStatus();if(state.riskTab==='decisions'){const select=document.querySelector('#riskDecision');select.value=state.riskDecision;document.querySelector('#riskDecisionFilter').onsubmit=e=>{e.preventDefault();state.riskDecision=select.value;state.riskPage=1;loadRiskAudit().catch(handleError)};const p=state.riskData.pagination;document.querySelector('#riskPrev').disabled=p.page<=1;document.querySelector('#riskNext').disabled=p.page>=p.total_pages;document.querySelector('#riskPrev').onclick=()=>{state.riskPage--;loadRiskAudit().catch(handleError)};document.querySelector('#riskNext').onclick=()=>{state.riskPage++;loadRiskAudit().catch(handleError)}}}
async function renderRiskAudit(){const main=document.querySelector('#adminMain');main.innerHTML=`<header class="page-head"><div><span class="eyebrow">交易安全与操作追溯</span><h1>风控与审计</h1><p>先确认平台和账户能否交易，再追溯每次风控决策与管理操作。</p></div><a class="secondary-button" href="/ai/?tab=global-risk">编辑全局规则</a></header>${riskTabs()}<div id="riskContent"><div class="panel"><div class="empty-state">正在读取风控状态…</div></div></div>`;document.querySelectorAll('[data-risk-tab]').forEach(button=>button.onclick=async()=>{state.riskTab=button.dataset.riskTab;document.querySelectorAll('[data-risk-tab]').forEach(item=>item.classList.toggle('is-active',item===button));if(state.riskTab==='audit')await renderAuditEvents();else {if(!state.riskData)await loadRiskAudit();else renderRiskContent()}});await loadRiskAudit()}

function contentTabs(){return `<nav class="segment-tabs" aria-label="内容与系统分类"><button class="segment-tab ${state.contentTab==='courses'?'is-active':''}" data-content-tab="courses" type="button">课程内容</button><button class="segment-tab ${state.contentTab==='feedback'?'is-active':''}" data-content-tab="feedback" type="button">用户反馈</button><button class="segment-tab ${state.contentTab==='system'?'is-active':''}" data-content-tab="system" type="button">系统发布</button></nav>`}
const courseStatusLabels={published:'已发布',draft:'草稿',archived:'已归档'}
const accessLabels={free:'公开免费',logged_in:'登录可看',plus_pro:'Plus / Pro',pro_only:'仅 Pro'}
async function renderContentCourses(){const params=new URLSearchParams({page:String(state.contentPage),page_size:'20',status:state.contentStatus});if(state.contentSearch)params.set('search',state.contentSearch);const data=await api(`/api/admin/content-system/courses?${params}`);document.querySelector('#contentSystemBody').innerHTML=`<section class="panel"><form class="filter-bar" id="courseFilters"><div class="field"><label for="contentSearch">搜索课程</label><input class="input" id="contentSearch" value="${escapeHtml(state.contentSearch)}" placeholder="课程名称、说明或分类"></div><div class="field"><label for="contentStatus">发布状态</label><select class="select" id="contentStatus"><option value="all">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option><option value="archived">已归档</option></select></div><a class="secondary-button" href="/legacy-admin">新增或编辑课程</a></form><div class="content-card-list">${data.courses.map(course=>`<article class="content-card"><div class="content-card-index">${String(course.number||course.id).padStart(2,'0')}</div><div class="content-card-main"><div><strong>${escapeHtml(course.title)}</strong><span class="badge ${course.status==='published'?'active':''}">${courseStatusLabels[course.status]||'未知状态'}</span></div><small>${escapeHtml(course.category||'未分类')} · ${course.content_type==='article'?'文章':'视频'} · ${accessLabels[course.access_level]||course.access_level}</small><p>测试 ${course.quiz_count} · 思维导图 ${course.mindmap_count} · 知识点 ${course.knowledge_count}</p></div></article>`).join('')||'<div class="empty-state">没有符合条件的课程</div>'}</div><div class="pagination"><button class="secondary-button" id="contentPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="contentNext" type="button">下一页</button></div></section>`;const status=document.querySelector('#contentStatus');status.value=state.contentStatus;document.querySelector('#courseFilters').onsubmit=e=>e.preventDefault();status.onchange=()=>{state.contentStatus=status.value;state.contentPage=1;renderContentCourses().catch(handleError)};document.querySelector('#contentSearch').onchange=e=>{state.contentSearch=e.target.value.trim();state.contentPage=1;renderContentCourses().catch(handleError)};document.querySelector('#contentPrev').disabled=data.pagination.page<=1;document.querySelector('#contentNext').disabled=data.pagination.page>=data.pagination.total_pages;document.querySelector('#contentPrev').onclick=()=>{state.contentPage--;renderContentCourses().catch(handleError)};document.querySelector('#contentNext').onclick=()=>{state.contentPage++;renderContentCourses().catch(handleError)}}
async function renderContentFeedback(){const params=new URLSearchParams({page:String(state.feedbackPage),page_size:'20'});if(state.feedbackSearch)params.set('search',state.feedbackSearch);const data=await api(`/api/admin/content-system/feedback?${params}`);document.querySelector('#contentSystemBody').innerHTML=`<section class="panel"><form class="filter-bar compact-filter" id="feedbackFilters"><div class="field"><label for="feedbackSearch">搜索反馈</label><input class="input" id="feedbackSearch" value="${escapeHtml(state.feedbackSearch)}" placeholder="标题、内容、联系方式或用户"></div><button class="secondary-button" type="submit">搜索</button></form><div class="feedback-list">${data.feedback.map(item=>`<article class="feedback-card"><header><div><span class="badge">${escapeHtml(item.type||'建议')}</span><strong>${escapeHtml(item.title)}</strong></div><time>${formatDate(item.created_at,true)}</time></header><p>${escapeHtml(item.description)}</p><footer>${escapeHtml(item.user_nickname||item.user_email||'匿名用户')} · ${escapeHtml(item.contact||'未留联系方式')}</footer></article>`).join('')||'<div class="empty-state">暂无用户反馈</div>'}</div><div class="pagination"><button class="secondary-button" id="feedbackPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="feedbackNext" type="button">下一页</button></div></section>`;document.querySelector('#feedbackFilters').onsubmit=e=>{e.preventDefault();state.feedbackSearch=document.querySelector('#feedbackSearch').value.trim();state.feedbackPage=1;renderContentFeedback().catch(handleError)};document.querySelector('#feedbackPrev').disabled=data.pagination.page<=1;document.querySelector('#feedbackNext').disabled=data.pagination.page>=data.pagination.total_pages;document.querySelector('#feedbackPrev').onclick=()=>{state.feedbackPage--;renderContentFeedback().catch(handleError)};document.querySelector('#feedbackNext').onclick=()=>{state.feedbackPage++;renderContentFeedback().catch(handleError)}}
function renderContentSystem(){const o=state.contentOverview;document.querySelector('#contentSystemBody').innerHTML=`<section class="content-grid"><article class="panel"><header class="section-head"><div><h2>发布说明</h2><p>主站和 AI 实验室共用当前版本说明。</p></div></header><form class="panel-body release-form" id="releaseForm"><div class="field"><label for="releaseVersion">版本号</label><input class="input" id="releaseVersion" required maxlength="32" value="${escapeHtml(o.release.version)}"></div><div class="field"><label for="releaseContent">更新内容</label><textarea class="input release-textarea" id="releaseContent" required>${escapeHtml(o.release.content)}</textarea></div><button class="primary-button" type="submit">保存发布说明</button></form></article><article class="panel"><header class="section-head"><div><h2>配置分类</h2><p>敏感值继续由原配置服务脱敏保护。</p></div></header><div class="config-category-list">${o.categories.map(item=>`<div class="config-category"><div><strong>${escapeHtml(item.category)}</strong><small>${item.item_count} 个配置项</small></div><span>${formatDate(item.updated_at,true)}</span></div>`).join('')}</div><div class="panel-body"><a class="secondary-button full-button" href="/legacy-admin">打开高级系统配置</a></div></article></section>`;document.querySelector('#releaseForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await api('/api/admin/release-notes',{method:'POST',body:JSON.stringify({version:document.querySelector('#releaseVersion').value.trim(),content:document.querySelector('#releaseContent').value.trim()})});toast('发布说明已保存','success');await loadContentOverview()}catch(error){handleError(error)}finally{button.disabled=false}}}
async function loadContentOverview(){const data=await api('/api/admin/content-system/overview');state.contentOverview=data.overview;if(state.contentTab==='system')renderContentSystem()}
async function renderContentTab(){if(state.contentTab==='feedback')await renderContentFeedback();else if(state.contentTab==='system'){if(!state.contentOverview)await loadContentOverview();else renderContentSystem()}else await renderContentCourses()}
async function renderContentSystemPage(){const main=document.querySelector('#adminMain');main.innerHTML=`<header class="page-head"><div><span class="eyebrow">课程、反馈与版本发布</span><h1>内容与系统</h1><p>日常内容运营与低频系统维护分开处理，降低配置干扰。</p></div></header>${contentTabs()}<div id="contentSystemBody"><div class="panel"><div class="empty-state">正在读取内容数据…</div></div></div>`;document.querySelectorAll('[data-content-tab]').forEach(button=>button.onclick=async()=>{state.contentTab=button.dataset.contentTab;document.querySelectorAll('[data-content-tab]').forEach(item=>item.classList.toggle('is-active',item===button));await renderContentTab()});await Promise.all([loadContentOverview(),renderContentTab()])}

async function setView(view) {
  state.view = view
  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.toggle('is-active', item.dataset.view === view))
  history.replaceState({}, '', `/admin/${view === 'overview' ? '' : `?view=${view}`}`)
  document.body.classList.remove('nav-open')
  document.querySelector('#drawerScrim').hidden = true
  try {
    if (view === 'users') await renderUsers()
    else if (view === 'commercial') await renderCommercial()
    else if (view === 'ai-operations') await renderAiOperations()
    else if (view === 'risk-audit') await renderRiskAudit()
    else if (view === 'content-system') await renderContentSystemPage()
    else await renderOverview()
    document.querySelector('#adminMain').focus({ preventScroll:true })
  } catch (error) { handleError(error) }
}

document.querySelectorAll('.nav-item[data-view]').forEach(item => item.addEventListener('click', () => setView(item.dataset.view)))
document.querySelector('#refreshButton').addEventListener('click', () => setView(state.view))
document.querySelector('#accountButton').addEventListener('click', () => { location.href = '/account' })
document.querySelectorAll('[data-close-modal]').forEach(item => item.addEventListener('click', closeUserModal))
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('#userModal').hidden) closeUserModal() })
document.querySelector('#mobileMenuButton').addEventListener('click', () => { const open = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', open); document.querySelector('#drawerScrim').hidden = !open; document.querySelector('#mobileMenuButton').setAttribute('aria-expanded',String(open)) })
document.querySelector('#drawerScrim').addEventListener('click', () => { document.body.classList.remove('nav-open'); document.querySelector('#drawerScrim').hidden = true })

async function bootstrap() {
  try {
    await loadProfile()
    const requested = new URLSearchParams(location.search).get('view')
    await setView(['users','commercial','ai-operations','risk-audit','content-system'].includes(requested) ? requested : 'overview')
  } catch (error) { handleError(error) }
}
bootstrap()
