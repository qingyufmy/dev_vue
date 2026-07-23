const state = {
  view:'overview', profile:null, overview:null, users:[], pagination:null, search:'', membership:'all', page:1, selectedUser:null,
  commercialTab:'orders', commercialOverview:null,
  orderPage:1, orderSearch:'', orderStatus:'all',
  notificationPage:1, notificationSearch:'', notificationStatus:'all', notificationChannel:'all',
  referralStatus:'all',
  aiTab:'health', aiOperations:null, observerCandidates:null,
  modelCompare:{ setup:null, strategyId:0, symbol:'', result:'all', page:1, snapshots:[], pagination:null, selected:new Map(), modelIds:new Set(), jobs:[], loading:false, polling:null },
  platformModels:{profiles:[],policy:null,governance:null},
  riskTab:'status', riskData:null, riskPolicy:null, riskPage:1, riskDecision:'all', auditPage:1, auditSearch:'', riskOpenGroup:'account',
  contentTab:'courses', contentOverview:null, contentPage:1, contentSearch:'', contentStatus:'all', feedbackPage:1, feedbackSearch:'', systemConfig:null, systemConfigCategory:'plan_prices', courseAssets:{courses:[],episodeId:0,resources:null,questions:[],editingQuestion:null},
}

const viewLabels = {
  overview:'运营总览',
  users:'用户与会员',
  commercial:'商业运营',
  'ai-operations':'AI 运行管理',
  'risk-audit':'风控与审计',
  'content-system':'内容与系统',
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
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  more:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
}

function renderIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icons[el.dataset.icon]||''})}
renderIcons()

function token() { return localStorage.getItem('ws_token') || localStorage.getItem('authToken') || '' }
async function api(path, options = {}) {
  const formBody = typeof FormData !== 'undefined' && options.body instanceof FormData
  const headers = { ...(options.body && !formBody ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
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
      <aside class="panel"><header class="section-head"><div><h2>管理边界</h2><p>统一入口，按业务域分工。</p></div></header><div class="panel-body"><div class="notice">用户、会员、商业运营、AI 运行、风控审计、内容与系统状态均从这里管理；少数高级编辑器继续作为对应业务页中的兼容工具，不再形成第二套后台。</div></div></aside>
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
async function loadSelectedUserOperations(userId) {
  const data=await api(`/api/ai/admin/users/${Number(userId)}/operations-detail`)
  if(state.selectedUser?.user?.id===Number(userId))state.selectedUser.operations=data
  return data
}
function operationsRiskField(key,meta,account) {
  if(meta.user_editable===false||meta.locked||meta.configurable===false||meta.type!=='number')return ''
  const risk=account.effective_risk||{}, own=risk.accountValues||{}, policy=risk.policy||{}
  const unit=meta.unit_label||meta.unit||''
  return `<label><span><strong>${escapeHtml(meta.label||key)}</strong><small>当前生效 ${escapeHtml(policy[key]??'继承平台')} ${escapeHtml(unit)}</small></span><div class="unit-input"><input class="input" type="number" step="any" data-account-risk-key="${escapeHtml(key)}" value="${own[key]==null?'':escapeHtml(own[key])}" placeholder="继承平台"><span>${escapeHtml(unit)}</span></div></label>`
}
function userOperationsMarkup(data) {
  const settings=data.settings||{}, accounts=data.accounts||[], subscriptions=data.subscriptions||[], strategies=data.strategies||[], rules=data.rule_metadata||{}
  const strategyOptions=selectedId=>strategies.map(strategy=>`<option value="${strategy.id}" ${Number(strategy.id)===Number(selectedId)?'selected':''}>${escapeHtml(strategy.title)} · ${strategy.scope==='private'?'用户私有':'平台策略'}</option>`).join('')
  const accountRows=accounts.map(account=>{const currency=account.account_currency||'',syncReady=account.realized_net!=null,riskFields=Object.entries(rules).map(([key,meta])=>operationsRiskField(key,meta,account)).filter(Boolean).join('');return `<article class="operations-account" data-operations-account="${Number(account.id)}"><header><div><span class="eyebrow">MT5 账户</span><strong>${escapeHtml(account.nickname||account.login_account||`账户 #${account.id}`)}</strong><small>${escapeHtml(account.broker_server||'未知服务器')} · ${escapeHtml(account.login_account||'--')}</small></div><span class="badge ${account.observe_status==='active'?'active':''}">${account.observe_status==='active'?'当前接入':'历史账户'}</span></header><div class="operations-metrics"><div><span>接入后累计收益</span><strong class="${Number(account.realized_net||0)<0?'negative':'positive'}">${syncReady?`${Number(account.realized_net).toFixed(2)} ${escapeHtml(currency)}`:'同步中'}</strong><small>仅平仓净收益</small></div><div><span>资金净流入</span><strong>${syncReady?`${Number(account.net_funding||0).toFixed(2)} ${escapeHtml(currency)}`:'--'}</strong><small>入金－出金＋调整</small></div><div><span>已平仓</span><strong>${account.closed_position_count??'--'}</strong><small>胜 ${account.winning_exit_count??'--'} · 负 ${account.losing_exit_count??'--'}</small></div><div><span>风控状态</span><strong>${account.halt_status==='active'||!account.halt_status?'允许交易':'暂停新开仓'}</strong><small>回撤 ${account.drawdown_pct??'--'}% · 连亏 ${account.consecutive_losses??'--'}</small></div></div><details class="operations-disclosure"><summary><span><strong>编辑账户风控</strong><small>留空表示继承平台规则，保存后立即生效。</small></span><span>展开</span></summary><div class="operations-risk-grid">${riskFields||'<div class="empty-inline">该账户没有可由用户自定义的规则</div>'}</div><div class="operations-actions"><button class="primary-button" data-save-account-risk type="button">保存账户风控</button></div></details></article>`}).join('')
  const subscriptionRows=subscriptions.map(item=>`<article class="operations-subscription" data-operations-subscription="${Number(item.id)}"><div><strong>${escapeHtml(item.strategy_title||`策略 #${item.strategy_id}`)}</strong><small>${escapeHtml(item.broker_server||'MT5')} · ${escapeHtml(item.login_account||'--')}</small></div><select class="select" data-subscription-strategy aria-label="选择推理策略">${strategyOptions(item.strategy_id)}</select><label class="runtime-checkbox"><input type="checkbox" data-subscription-enabled ${Number(item.execution_enabled)?'checked':''}><span>自动分析</span></label><button class="secondary-button" data-save-subscription type="button">保存</button></article>`).join('')
  return `<section class="operations-runtime"><div><span class="eyebrow">实时运行控制</span><h3>自动分析与交易发送</h3><p>保存后立即同步；桥接离线时保留期望状态，重连后恢复。</p></div><label class="runtime-control"><input id="operationsAutoReasoning" type="checkbox" ${Number(settings.auto_reasoning_enabled)?'checked':''}><span><strong>自动分析</strong><small>${data.bridge?.connected?'桥接在线，可实时同步':'桥接离线，等待重连'}</small></span></label><label class="runtime-control danger"><input id="operationsTradeSend" type="checkbox" ${Number(settings.trade_send_enabled)?'checked':''}><span><strong>交易发送</strong><small>允许系统向该用户账户发送订单</small></span></label><button class="primary-button" id="saveOperationsRuntime" type="button">保存运行状态</button></section><section class="operations-section"><header><div><span class="eyebrow">账户与收益</span><h3>接入过的 MT5 账户</h3><p>收益按账户归属期与 MT5 平仓时间统计。</p></div><span class="badge">${accounts.length} 个账户</span></header><div class="operations-account-list">${accountRows||'<div class="empty-state compact-empty">尚未接入 MT5 账户</div>'}</div></section><section class="operations-section"><header><div><span class="eyebrow">策略运行</span><h3>策略订阅</h3><p>调整绑定策略和自动分析状态，修改会进入审计记录。</p></div><span class="badge">${subscriptions.length} 条</span></header><div class="operations-subscription-list">${subscriptionRows||'<div class="empty-state compact-empty">暂无策略订阅</div>'}</div></section>`
}
function bindUserOperations(userId) {
  const body=document.querySelector('#userModalBody')
  body.querySelector('#saveOperationsRuntime')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await api(`/api/ai/admin/users/${userId}/runtime`,{method:'PATCH',body:JSON.stringify({auto_reasoning_enabled:body.querySelector('#operationsAutoReasoning').checked,trade_send_enabled:body.querySelector('#operationsTradeSend').checked})});toast('用户运行状态已保存','success');await loadSelectedUserOperations(userId);renderUserDetail('operations')}catch(error){handleError(error);event.currentTarget.disabled=false}})
  body.querySelectorAll('[data-save-account-risk]').forEach(button=>button.addEventListener('click',async()=>{const card=button.closest('[data-operations-account]'),changes={};card.querySelectorAll('[data-account-risk-key]').forEach(input=>{changes[input.dataset.accountRiskKey]=input.value===''?null:Number(input.value)});button.disabled=true;try{await api(`/api/ai/admin/users/${userId}/accounts/${card.dataset.operationsAccount}/risk`,{method:'PUT',body:JSON.stringify({changes})});toast('账户风控已保存并立即生效','success');await loadSelectedUserOperations(userId);renderUserDetail('operations')}catch(error){handleError(error);button.disabled=false}}))
  body.querySelectorAll('[data-save-subscription]').forEach(button=>button.addEventListener('click',async()=>{const row=button.closest('[data-operations-subscription]');button.disabled=true;try{await api(`/api/ai/admin/users/${userId}/subscriptions/${row.dataset.operationsSubscription}`,{method:'PUT',body:JSON.stringify({strategy_id:Number(row.querySelector('[data-subscription-strategy]').value),execution_enabled:row.querySelector('[data-subscription-enabled]').checked,replace_active:true})});toast('策略订阅已保存','success');await loadSelectedUserOperations(userId);renderUserDetail('operations')}catch(error){handleError(error);button.disabled=false}}))
}
function renderUserDetail(tab) {
  const { user, runtime, accounts, subscriptions } = state.selectedUser
  document.querySelector('#userModalTitle').textContent = user.nickname || user.email || `用户 #${user.id}`
  const body = document.querySelector('#userModalBody')
  const hero = `<div class="detail-hero"><span class="user-avatar">${escapeHtml((user.nickname || user.email || '用').slice(0,1))}</span><div><h3>${escapeHtml(user.nickname || '未设置昵称')} ${membershipBadge(user)}</h3><p>${escapeHtml(user.email)} · ${escapeHtml(user.uid)}</p></div></div><div class="detail-tabs"><button class="detail-tab ${tab === 'profile' ? 'is-active' : ''}" data-detail-tab="profile" type="button">运营档案</button><button class="detail-tab ${tab === 'trading' ? 'is-active' : ''}" data-detail-tab="trading" type="button">交易接入</button><button class="detail-tab ${tab === 'operations' ? 'is-active' : ''}" data-detail-tab="operations" type="button">运行与风控</button></div>`
  if (tab === 'operations') {
    if(state.selectedUser.operations){body.innerHTML=`${hero}${userOperationsMarkup(state.selectedUser.operations)}`;bindUserOperations(user.id)}
    else{body.innerHTML=`${hero}<div class="empty-state">正在读取运行与风控数据…</div>`;loadSelectedUserOperations(user.id).then(()=>renderUserDetail('operations')).catch(error=>{handleError(error);renderUserDetail('trading')})}
  } else if (tab === 'trading') {
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
    <button type="button" class="segment-tab ${state.aiTab === 'models' ? 'is-active' : ''}" data-ai-tab="models">平台模型</button>
    <button type="button" class="segment-tab ${state.aiTab === 'observer' ? 'is-active' : ''}" data-ai-tab="observer">观摩频道</button>
    <button type="button" class="segment-tab ${state.aiTab === 'model-compare' ? 'is-active' : ''}" data-ai-tab="model-compare">模型评测</button>
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

function safeJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
function compareErrorLabel(code) {
  return ({
    history_compare_interrupted:'服务重启导致任务中断', history_compare_failed:'模型评测失败',
    history_compare_no_market_data:'没有可用的历史行情', model_compare_no_valid_response:'模型没有返回有效结果',
    snapshot_compare_selection_invalid:'历史信号证据已失效', backtest_execution_candles_unavailable:'成交回放所需行情不足',
    backtest_symbol_snapshot_unavailable:'交易品种参数不可用', no_actionable_signals:'模型未给出可执行方向',
  })[String(code || '')] || '任务未能完成，请查看服务器日志'
}
function compareStatusLabel(status) {
  return ({queued:'等待开始',running:'评测中',cancelling:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消'})[status] || '状态未知'
}
function strategySymbols(strategy) {
  const symbols = safeJson(strategy?.symbols_json, [])
  return Array.isArray(symbols) ? symbols.map(value => String(value || '').trim().toUpperCase()).filter(Boolean) : []
}
function strategyPrimaryTimeframe(strategy) {
  const plan = safeJson(strategy?.market_data_plan_json, {}) || {}
  return String(plan.primary_timeframe || plan.timeframes?.[0]?.timeframe || '--').toUpperCase()
}
function modelCompareBuilder() {
  const compare = state.modelCompare
  const setup = compare.setup
  if (!setup) return '<section class="panel"><div class="empty-state">正在准备模型评测工作区…</div></section>'
  const strategy = setup.strategies.find(item => Number(item.id) === Number(compare.strategyId))
  const lockedVersion = compare.selected.size ? Number([...compare.selected.values()][0]?.strategy_version || 1) : null
  const snapshots = compare.snapshots.map(item => {
    const selected = compare.selected.has(Number(item.snapshot_id))
    const locked = lockedVersion != null && Number(item.strategy_version || 1) !== lockedVersion
    const profit = Number(item.net_profit || 0)
    return `<label class="compare-snapshot ${selected ? 'is-selected' : ''} ${locked ? 'is-locked' : ''}"><input type="checkbox" data-compare-snapshot="${Number(item.snapshot_id)}" ${selected ? 'checked' : ''} ${locked ? 'disabled' : ''}><span class="snapshot-check" aria-hidden="true"></span><span class="snapshot-copy"><strong>信号 #${Number(item.signal_id)} · ${item.original_signal_type?.includes('buy') ? '做多' : item.original_signal_type?.includes('sell') ? '做空' : '观望'}</strong><small>${escapeHtml(formatDate(item.signal_created_at,true))} · 策略版本 ${Number(item.strategy_version || 1)}</small></span><span class="snapshot-outcome ${profit < 0 ? 'negative' : profit > 0 ? 'positive' : ''}"><strong>${profit > 0 ? '+' : ''}${profit.toFixed(2)}</strong><small>${Number(item.trade_count || 0)} 笔成交</small></span></label>`
  }).join('')
  const models = setup.profiles.map(profile => `<label class="compare-model ${compare.modelIds.has(Number(profile.id)) ? 'is-selected' : ''}"><input type="checkbox" data-compare-model="${Number(profile.id)}" ${compare.modelIds.has(Number(profile.id)) ? 'checked' : ''}><span><strong>${escapeHtml(profile.model_name || '未命名模型')}</strong><small>${escapeHtml(profile.provider || '模型服务')} ${profile.thinking_enabled ? '· 深度思考' : ''}</small></span><em>${compare.modelIds.has(Number(profile.id)) ? '已选择' : '可用'}</em></label>`).join('')
  const totalPages = Math.max(1, Math.ceil(Number(compare.pagination?.total || 0) / Number(compare.pagination?.page_size || 10)))
  const canRun = compare.selected.size >= 2 && compare.modelIds.size >= 2 && compare.modelIds.size <= 5 && strategy && compare.symbol
  return `<section class="compare-workspace">
    <article class="panel compare-setup-panel"><header class="section-head"><div><span class="eyebrow">新建评测</span><h2>用真实历史信号比较模型</h2><p>复用信号生成时的策略、行情与结构证据，不触发实盘风控或交易。</p></div></header><div class="compare-setup-body">
      <div class="compare-form-grid"><label class="field"><span>平台策略</span><select class="select" id="compareStrategy">${setup.strategies.map(item => `<option value="${item.id}" ${Number(item.id)===Number(compare.strategyId)?'selected':''}>${escapeHtml(item.title)}</option>`).join('')}</select></label><label class="field"><span>交易品种</span><select class="select" id="compareSymbol">${strategySymbols(strategy).map(symbol => `<option value="${escapeHtml(symbol)}" ${symbol===compare.symbol?'selected':''}>${escapeHtml(symbol)}</option>`).join('')}</select></label><div class="compare-context"><span>评测上下文</span><strong>${escapeHtml(strategyPrimaryTimeframe(strategy))} 主周期 · 策略版本自动锁定</strong></div></div>
      <div class="compare-section-head"><div><strong>1. 选择历史信号</strong><small>至少 2 条；一次评测只能使用同一策略版本。</small></div><select class="select compact-select" id="compareOutcome"><option value="all" ${compare.result==='all'?'selected':''}>全部结果</option><option value="profit" ${compare.result==='profit'?'selected':''}>仅盈利</option><option value="loss" ${compare.result==='loss'?'selected':''}>仅亏损</option><option value="flat" ${compare.result==='flat'?'selected':''}>盈亏持平</option></select></div>
      <div class="compare-snapshot-list">${snapshots || '<div class="empty-state compact-empty">当前策略和品种暂无完整历史信号快照</div>'}</div><div class="compare-pagination"><span>已选 ${compare.selected.size} 条 · 共 ${Number(compare.pagination?.total || 0)} 条</span><div><button class="secondary-button" id="comparePrev" type="button" ${compare.page<=1?'disabled':''}>上一页</button><span>${compare.page} / ${totalPages}</span><button class="secondary-button" id="compareNext" type="button" ${compare.page>=totalPages?'disabled':''}>下一页</button></div></div>
      <div class="compare-section-head"><div><strong>2. 选择对比模型</strong><small>选择 2–5 个模型，所有模型接收完全相同的证据。</small></div><span class="selection-count">已选 ${compare.modelIds.size} 个</span></div><div class="compare-model-grid">${models || '<div class="empty-state compact-empty">没有可用的平台模型</div>'}</div>
      <div class="compare-runbar"><div><strong>预计请求 ${compare.selected.size * compare.modelIds.size} 次</strong><small>模型输出修复可能额外产生少量请求</small></div><button class="primary-button" id="compareRun" type="button" ${canRun&&!compare.loading?'':'disabled'}>${compare.loading?'正在提交…':'开始评测'}</button></div>
    </div></article>
    <article class="panel compare-jobs-panel"><header class="section-head"><div><span class="eyebrow">任务记录</span><h2>最近评测</h2><p>任务在后台运行，离开页面不会中断。</p></div><button class="secondary-button" id="compareRefreshJobs" type="button">刷新</button></header><div id="compareJobs">${modelCompareJobs()}</div></article>
  </section>`
}
function modelCompareJobs() {
  const jobs = state.modelCompare.jobs || []
  if (!jobs.length) return '<div class="empty-state compact-empty">还没有模型评测任务</div>'
  return `<div class="compare-job-list">${jobs.map(job => {
    const params = job.params || {}, active = ['queued','running','cancelling'].includes(job.status)
    return `<article class="compare-job ${active ? 'is-active' : ''}" data-compare-job="${escapeHtml(job.id)}"><div class="job-state ${escapeHtml(job.status)}"></div><div class="job-copy"><strong>${escapeHtml(params.symbol || '未知品种')} · ${Number(params.snapshot_ids?.length || 0)} 条信号</strong><small>${Number(params.model_ids?.length || 0)} 个模型 · ${escapeHtml(formatDate(job.created_at,true))}</small>${job.status==='failed'?`<p>${escapeHtml(compareErrorLabel(job.error))}</p>`:''}${active?`<div class="job-progress"><span style="width:${Math.max(2,Number(job.progress_percent||0))}%"></span></div>`:''}</div><span class="badge ${job.status==='succeeded'?'active':job.status==='failed'?'expired':''}">${compareStatusLabel(job.status)}${active?` ${Number(job.progress_percent||0)}%`:''}</span><div class="job-actions">${job.status==='succeeded'?'<button class="text-button" data-open-compare-result type="button">查看结果</button>':''}${['succeeded','failed','cancelled'].includes(job.status)?'<button class="icon-button compact-icon" data-delete-compare-job type="button" aria-label="删除评测任务"><span data-icon="close"></span></button>':''}</div></article>`
  }).join('')}</div>`
}
function renderModelCompareContent() {
  const content = document.querySelector('#aiOperationsContent')
  if (!content) return
  content.innerHTML = modelCompareBuilder()
  renderIcons(content)
  bindModelCompare()
}
async function loadModelCompareSnapshots() {
  const compare = state.modelCompare
  if (!compare.strategyId || !compare.symbol) { compare.snapshots=[]; compare.pagination=null; renderModelCompareContent(); return }
  const query = new URLSearchParams({strategy_id:String(compare.strategyId),symbol:compare.symbol,result:compare.result,page:String(compare.page),page_size:'10'})
  const data = await api(`/api/admin/ai/model-compare/snapshots?${query}`)
  compare.snapshots = data.samples || []
  compare.pagination = data.pagination || null
  renderModelCompareContent()
}
async function loadModelCompareJobs({ render=true } = {}) {
  const data = await api('/api/admin/ai/model-compare/jobs?limit=12')
  state.modelCompare.jobs = data.jobs || []
  if (render) renderModelCompareContent()
  const active = state.modelCompare.jobs.some(job => ['queued','running','cancelling'].includes(job.status))
  clearTimeout(state.modelCompare.polling)
  state.modelCompare.polling = active && state.aiTab === 'model-compare'
    ? setTimeout(() => loadModelCompareJobs().catch(handleError), 2500)
    : null
}
async function loadModelCompareWorkspace() {
  const compare = state.modelCompare
  if (!compare.setup) {
    compare.setup = await api('/api/admin/ai/model-compare/setup')
    compare.strategyId = Number(compare.setup.strategies?.[0]?.id || 0)
    const strategy = compare.setup.strategies?.[0]
    compare.symbol = strategySymbols(strategy)[0] || ''
    compare.modelIds = new Set((compare.setup.profiles || []).slice(0,2).map(item => Number(item.id)))
  }
  await Promise.all([loadModelCompareSnapshots(),loadModelCompareJobs({render:false})])
  renderModelCompareContent()
}
function compareResultValue(value, suffix='') {
  const number = Number(value)
  return Number.isFinite(number) ? `${number.toFixed(1)}${suffix}` : '--'
}
async function openModelCompareResult(jobId) {
  const data = await api(`/api/admin/ai/model-compare/jobs/${encodeURIComponent(jobId)}`)
  const result = data.job?.result
  if (!result) throw new Error('评测结果尚未生成')
  const models = (result.results || []).slice().sort((a,b) => Number(b.directional_score?.direction_quality_score || 0)-Number(a.directional_score?.direction_quality_score || 0))
  const rows = models.map((model,index) => {
    const score=model.directional_score||{}, simulation=model.account_simulation||{}
    const profit=Number(simulation.net_profit ?? simulation.total_net_profit)
    return `<article class="compare-result-row ${model.status!=='success'?'has-error':''}"><span class="result-rank">${index+1}</span><div class="result-model"><strong>${escapeHtml(model.model_name || `模型 #${model.model_id}`)}</strong><small>${escapeHtml(model.provider || '模型服务')} · ${Number(score.actionable_count || 0)} 次出手</small></div><div><span>方向质量</span><strong>${compareResultValue(score.direction_quality_score)}</strong></div><div><span>方向准确率</span><strong>${compareResultValue(score.directional_accuracy,'%')}</strong></div><div><span>输出合规率</span><strong>${compareResultValue(score.output_compliance_rate,'%')}</strong></div><div><span>平均置信度</span><strong>${compareResultValue(score.average_confidence,'%')}</strong></div><div><span>模拟净收益</span><strong class="${profit<0?'negative':profit>0?'positive':''}">${Number.isFinite(profit)?`${profit>0?'+':''}${profit.toFixed(2)}`:simulation.status==='unavailable'?'证据不足':'--'}</strong></div></article>`
  }).join('')
  openEntityModal({title:'模型评测结果',eyebrow:`${result.meta?.symbol || '历史信号'} · ${result.meta?.evaluation_count || 0} 个评估案例`,content:`<div class="compare-result-summary"><div><span>实际模型请求</span><strong>${Number(result.meta?.actual_model_calls || 0)}</strong></div><div><span>成功请求</span><strong>${Number(result.meta?.successful_model_calls || 0)}</strong></div><div><span>平均一致率</span><strong>${compareResultValue(result.meta?.average_agreement_rate,'%')}</strong></div><div><span>令牌消耗</span><strong>${Number(result.meta?.model_token_count || 0).toLocaleString('zh-CN')}</strong></div></div><div class="compare-result-table">${rows || '<div class="empty-state">没有可展示的模型结果</div>'}</div><div class="modal-footer-note">结果仅用于比较模型在相同历史证据下的方向判断与输出质量，不会产生实盘订单。</div>`})
}
function bindModelCompare() {
  const compare=state.modelCompare,setup=compare.setup
  document.querySelector('#compareStrategy')?.addEventListener('change',async event=>{compare.strategyId=Number(event.target.value);const strategy=setup.strategies.find(item=>Number(item.id)===compare.strategyId);compare.symbol=strategySymbols(strategy)[0]||'';compare.page=1;compare.selected.clear();renderModelCompareContent();await loadModelCompareSnapshots().catch(handleError)})
  document.querySelector('#compareSymbol')?.addEventListener('change',async event=>{compare.symbol=event.target.value;compare.page=1;compare.selected.clear();await loadModelCompareSnapshots().catch(handleError)})
  document.querySelector('#compareOutcome')?.addEventListener('change',async event=>{compare.result=event.target.value;compare.page=1;await loadModelCompareSnapshots().catch(handleError)})
  document.querySelectorAll('[data-compare-snapshot]').forEach(input=>input.addEventListener('change',()=>{const id=Number(input.dataset.compareSnapshot),item=compare.snapshots.find(row=>Number(row.snapshot_id)===id);if(input.checked&&item)compare.selected.set(id,item);else compare.selected.delete(id);renderModelCompareContent()}))
  document.querySelectorAll('[data-compare-model]').forEach(input=>input.addEventListener('change',()=>{const id=Number(input.dataset.compareModel);if(input.checked){if(compare.modelIds.size>=5){input.checked=false;toast('每次最多选择 5 个模型','warning');return}compare.modelIds.add(id)}else compare.modelIds.delete(id);renderModelCompareContent()}))
  document.querySelector('#comparePrev')?.addEventListener('click',async()=>{compare.page=Math.max(1,compare.page-1);await loadModelCompareSnapshots().catch(handleError)})
  document.querySelector('#compareNext')?.addEventListener('click',async()=>{compare.page+=1;await loadModelCompareSnapshots().catch(handleError)})
  document.querySelector('#compareRefreshJobs')?.addEventListener('click',()=>loadModelCompareJobs().catch(handleError))
  document.querySelector('#compareRun')?.addEventListener('click',async buttonEvent=>{const button=buttonEvent.currentTarget;button.disabled=true;compare.loading=true;renderModelCompareContent();try{const data=await api('/api/admin/ai/model-compare/jobs',{method:'POST',body:JSON.stringify({strategy_id:compare.strategyId,symbol:compare.symbol,model_ids:[...compare.modelIds],data_source:'snapshots',snapshot_ids:[...compare.selected.keys()],timezone_offset_minutes:180,evaluation_mode:'sampled',backtest:{use_bridge_account_settings:true}})});toast('模型评测任务已开始','success');compare.selected.clear();await loadModelCompareJobs();if(data.job?.id)state.modelCompare.polling=setTimeout(()=>loadModelCompareJobs().catch(handleError),1200)}catch(error){handleError(error)}finally{compare.loading=false;renderModelCompareContent()}})
  document.querySelectorAll('[data-open-compare-result]').forEach(button=>button.addEventListener('click',()=>openModelCompareResult(button.closest('[data-compare-job]').dataset.compareJob).catch(handleError)))
  document.querySelectorAll('[data-delete-compare-job]').forEach(button=>button.addEventListener('click',async()=>{const jobId=button.closest('[data-compare-job]').dataset.compareJob;if(!await confirmAction('删除模型评测记录？','删除后无法恢复，但不会影响模型配置和历史信号。','确认删除',true))return;try{await api(`/api/admin/ai/model-compare/jobs/${encodeURIComponent(jobId)}`,{method:'DELETE'});toast('评测记录已删除','success');await loadModelCompareJobs()}catch(error){handleError(error)}}))
}
const providerLabels={deepseek:'DeepSeek',gpt:'OpenAI',kimi:'Moonshot Kimi',kimi_code:'Kimi Code 订阅',qwen:'通义千问',zhipu:'智谱 AI',doubao:'火山方舟',volcengine_agent_plan:'火山方舟 Agent Plan',openai_compatible:'自定义 OpenAI 兼容'}
const featureLabels={review_generation_enabled:['复盘生成','允许系统生成日复盘与月复盘'],experience_memory_enabled:['经验记忆','允许确认后的记忆参与推理'],memory_compression_enabled:['月度记忆压缩','允许模型压缩长期记忆'],retrieval_shadow_enabled:['影子检索','只记录命中效果，不注入正式推理'],paired_experiment_enabled:['配对试验','运行有记忆与无记忆的对照评估']}
function platformModelsContent() {
  const data=state.platformModels,profiles=data.profiles||[],policy=data.policy||{},health=data.governance||{},globalFlags=(health.feature_flags||[]).find(item=>item.scope==='global')||{},rollouts=health.risk_rule_rollouts||[]
  return `<section class="platform-model-layout"><article class="panel platform-model-panel"><header class="section-head"><div><span class="eyebrow">共享推理资源</span><h2>平台模型</h2><p>平台策略、复盘和授权用户共用这些模型配置。</p></div><button class="primary-button" data-new-platform-model type="button">添加模型</button></header><div class="platform-model-list">${profiles.map(profile=>`<article class="platform-model-row" data-platform-model="${Number(profile.id)}"><span class="provider-mark">${escapeHtml((providerLabels[profile.provider]||'模型').slice(0,1))}</span><div><strong>${escapeHtml(profile.model_name)}</strong><small>${escapeHtml(providerLabels[profile.provider]||'模型服务')} · ${profile.has_api_key?'密钥已配置':'密钥未配置'}${profile.thinking_enabled?' · 深度思考':''}</small></div>${Number(profile.is_default)?'<span class="badge active">默认模型</span>':'<span class="badge">备用模型</span>'}<div class="row-actions"><button class="text-button" data-test-platform-model type="button">测试</button>${Number(profile.is_default)?'':`<button class="text-button" data-default-platform-model type="button">设为默认</button>`}<button class="icon-button compact-icon" data-edit-platform-model type="button" aria-label="编辑模型"><span data-icon="more"></span></button></div></article>`).join('')||'<div class="empty-state compact-empty">还没有配置平台模型</div>'}</div></article><article class="panel"><header class="section-head"><div><span class="eyebrow">共享策略</span><h2>使用范围与配额</h2><p>决定哪些任务可以使用平台模型，以及单用户每日上限。</p></div></header><form class="platform-policy-form" id="platformModelPolicy"><div class="policy-switch-grid"><label><input type="checkbox" data-policy-flag="share_for_manual" ${Number(policy.share_for_manual)?'checked':''}><span><strong>手动分析</strong><small>用户没有私有模型时可使用</small></span></label><label><input type="checkbox" data-policy-flag="share_for_auto" ${Number(policy.share_for_auto)?'checked':''}><span><strong>自动分析</strong><small>私有模型缺失时使用平台模型</small></span></label><label><input type="checkbox" data-policy-flag="share_for_review" ${Number(policy.share_for_review)?'checked':''}><span><strong>复盘任务</strong><small>生成日复盘与月复盘</small></span></label><label><input type="checkbox" data-policy-flag="share_for_memory_compression" ${Number(policy.share_for_memory_compression)?'checked':''}><span><strong>记忆压缩</strong><small>生成月度长期记忆摘要</small></span></label></div><div class="form-grid"><label class="field"><span>允许会员</span><select class="select" id="platformAllowedPlans" multiple size="2"><option value="plus" ${safeJson(policy.allowed_plans,[]).includes('plus')?'selected':''}>Plus 用户</option><option value="pro" ${safeJson(policy.allowed_plans,['pro']).includes('pro')?'selected':''}>Pro 用户</option></select></label><label class="field"><span>每日请求上限 / 用户</span><input class="input" id="platformDailyRequests" type="number" min="1" value="${Number(policy.daily_requests_per_user||100)}"></label><label class="field"><span>每日令牌上限 / 用户</span><input class="input" id="platformDailyTokens" type="number" min="1000" step="1000" value="${Number(policy.daily_tokens_per_user||500000)}"></label></div><div class="form-actions"><button class="primary-button" type="submit">保存共享策略</button></div></form></article></section><section class="panel section-gap"><header class="section-head"><div><span class="eyebrow">灰度与安全</span><h2>AI 功能治理</h2><p>平台级开关影响所有用户；强制风控规则不能切换为影子模式。</p></div><button class="secondary-button" id="refreshAiGovernance" type="button">刷新状态</button></header><div class="governance-grid"><div><h3>平台功能开关</h3><div class="governance-switches">${Object.entries(featureLabels).map(([key,[label,description]])=>`<label><input type="checkbox" data-feature-flag="${key}" ${globalFlags[key]?'checked':''}><span><strong>${label}</strong><small>${description}</small></span></label>`).join('')}</div><button class="secondary-button" id="saveAiFeatureFlags" type="button">保存功能开关</button></div><div><h3>规则灰度</h3><div class="rollout-list">${rollouts.map(item=>`<label><span><strong>${escapeHtml(item.rule_code)}</strong><small>${Number(item.forced_enforce)?'系统强制执行':'可切换影子评估'}</small></span><select class="select" data-rollout-rule="${escapeHtml(item.rule_code)}" ${Number(item.forced_enforce)?'disabled':''}><option value="enforce" ${item.mode!=='shadow'?'selected':''}>正式执行</option><option value="shadow" ${item.mode==='shadow'?'selected':''}>仅影子评估</option></select></label>`).join('')||'<div class="empty-inline">暂无规则灰度记录</div>'}</div></div><div><h3>凭证维护</h3><div class="credential-state"><span>最近轮换</span><strong>${health.credential_migration?.status==='succeeded'?'已完成':health.credential_migration?.status==='failed'?'失败':'尚未执行'}</strong><small>${escapeHtml(formatDate(health.credential_migration?.completed_at||health.credential_migration?.started_at,true))}</small></div><button class="secondary-button full-button" id="rotateModelCredentials" type="button">重新加密全部模型密钥</button><button class="text-button danger-text full-button" id="clearLegacyCredentials" type="button">清理已验证的旧明文凭证</button></div></div></section>`
}
async function loadPlatformModels() {
  const [profiles,policy,governance]=await Promise.all([api('/api/ai/model-profiles?scope=platform'),api('/api/ai/platform-model-policy'),api('/api/ai/admin/rollout-health')])
  state.platformModels={profiles:profiles.profiles||[],policy:policy.policy||{},governance:governance.health||{}}
  renderPlatformModels()
}
function platformModelEditorMarkup(profile={}) {
  const selected=value=>profile.provider===value?'selected':''
  return `<form id="platformModelEditor" class="editor-form"><div class="form-grid"><label class="field"><span>模型服务</span><select class="select" id="platformModelProvider">${Object.entries(providerLabels).map(([value,label])=>`<option value="${value}" ${selected(value)}>${label}</option>`).join('')}</select></label><label class="field"><span>模型名称</span><input class="input" id="platformModelName" required value="${escapeHtml(profile.model_name||'deepseek-chat')}"></label><label class="field span-2"><span>接口地址</span><input class="input" id="platformModelBaseUrl" value="${escapeHtml(profile.api_base_url||'')}" placeholder="留空使用服务商默认地址"></label><label class="field span-2"><span>API 密钥</span><input class="input" id="platformModelApiKey" type="password" autocomplete="new-password" placeholder="${profile.has_api_key?'已安全配置；留空保持不变':'请输入 API 密钥'}"></label><label class="field"><span>最大输出令牌</span><input class="input" id="platformModelMaxTokens" type="number" min="100" value="${Number(profile.max_tokens||8000)}"></label><label class="field"><span>请求超时（毫秒）</span><input class="input" id="platformModelTimeout" type="number" min="30000" max="600000" step="1000" value="${Number(profile.request_timeout_ms||120000)}"></label><label class="field"><span>温度</span><input class="input" id="platformModelTemperature" type="number" min="0" max="2" step="0.1" value="${Number(profile.temperature??0.3)}"></label><label class="field"><span>推理强度</span><select class="select" id="platformModelEffort"><option value="low" ${profile.reasoning_effort==='low'?'selected':''}>低</option><option value="medium" ${profile.reasoning_effort==='medium'?'selected':''}>中</option><option value="high" ${profile.reasoning_effort==='high'?'selected':''}>高</option><option value="max" ${!profile.reasoning_effort||profile.reasoning_effort==='max'?'selected':''}>最高</option></select></label><label class="inline-check span-2"><input id="platformModelThinking" type="checkbox" ${profile.thinking_enabled?'checked':''}><span><strong>启用深度思考</strong><small>仅对服务商支持的模型生效，响应时间会增加。</small></span></label></div><div class="form-actions">${profile.id?'<button class="text-button danger-text" data-delete-platform-model type="button">删除模型</button>':''}<span class="action-spacer"></span><button class="secondary-button" data-close-entity-modal type="button">取消</button><button class="primary-button" type="submit">保存模型</button></div></form>`
}
function openPlatformModelEditor(profile=null) {
  openEntityModal({title:profile?'编辑平台模型':'添加平台模型',eyebrow:'共享模型配置',content:platformModelEditorMarkup(profile||{})});const root=document.querySelector('#entityModalBody');root.querySelector('[data-close-entity-modal]').onclick=closeEntityModal
  root.querySelector('[data-delete-platform-model]')?.addEventListener('click',async()=>{try{const impact=(await api(`/api/ai/model-profiles/${profile.id}/delete-impact?scope=platform`)).impact;if(!impact.can_delete)return handleError(new Error(impact.is_default?'默认模型不能删除，请先更换默认模型':'该模型仍被策略使用，不能删除'));if(!await confirmAction('删除平台模型？',`确认删除“${profile.model_name}”？模型配置和密钥会被永久移除。`,'确认删除',true))return;await api(`/api/ai/model-profiles/${profile.id}?scope=platform`,{method:'DELETE',body:JSON.stringify({confirm_name:profile.model_name,confirm_id:profile.id})});toast('平台模型已删除','success');closeEntityModal();await loadPlatformModels()}catch(error){handleError(error)}})
  root.querySelector('#platformModelEditor').onsubmit=async event=>{event.preventDefault();const button=event.submitter,payload={scope:'platform',provider:root.querySelector('#platformModelProvider').value,model_name:root.querySelector('#platformModelName').value.trim(),api_base_url:root.querySelector('#platformModelBaseUrl').value.trim()||null,api_key:root.querySelector('#platformModelApiKey').value.trim()||undefined,max_tokens:Number(root.querySelector('#platformModelMaxTokens').value),request_timeout_ms:Number(root.querySelector('#platformModelTimeout').value),temperature:Number(root.querySelector('#platformModelTemperature').value),thinking_enabled:root.querySelector('#platformModelThinking').checked,reasoning_effort:root.querySelector('#platformModelEffort').value};button.disabled=true;try{await api(profile?`/api/ai/model-profiles/${profile.id}`:'/api/ai/model-profiles',{method:profile?'PUT':'POST',body:JSON.stringify(payload)});toast('平台模型已保存','success');closeEntityModal();await loadPlatformModels()}catch(error){handleError(error);button.disabled=false}}
}
function renderPlatformModels() {
  const content=document.querySelector('#aiOperationsContent');if(!content)return;content.innerHTML=platformModelsContent();renderIcons(content)
  document.querySelector('[data-new-platform-model]')?.addEventListener('click',()=>openPlatformModelEditor())
  document.querySelectorAll('[data-edit-platform-model]').forEach(button=>button.onclick=()=>{const profile=state.platformModels.profiles.find(item=>Number(item.id)===Number(button.closest('[data-platform-model]').dataset.platformModel));openPlatformModelEditor(profile)})
  document.querySelectorAll('[data-test-platform-model]').forEach(button=>button.onclick=async()=>{const id=button.closest('[data-platform-model]').dataset.platformModel;button.disabled=true;button.textContent='测试中…';try{const result=await api(`/api/ai/model-profiles/${id}/test`,{method:'POST',body:JSON.stringify({scope:'platform'})});toast(`模型连接正常，响应 ${(Number(result.latency_ms||0)/1000).toFixed(1)} 秒`,'success')}catch(error){handleError(error)}finally{button.disabled=false;button.textContent='测试'}})
  document.querySelectorAll('[data-default-platform-model]').forEach(button=>button.onclick=async()=>{const id=button.closest('[data-platform-model]').dataset.platformModel;try{await api(`/api/ai/model-profiles/${id}/default`,{method:'POST',body:JSON.stringify({scope:'platform'})});toast('默认平台模型已更新','success');await loadPlatformModels()}catch(error){handleError(error)}})
  document.querySelector('#platformModelPolicy').onsubmit=async event=>{event.preventDefault();const payload={allowed_plans:[...document.querySelector('#platformAllowedPlans').selectedOptions].map(option=>option.value),daily_requests_per_user:Number(document.querySelector('#platformDailyRequests').value),daily_tokens_per_user:Number(document.querySelector('#platformDailyTokens').value)};document.querySelectorAll('[data-policy-flag]').forEach(input=>payload[input.dataset.policyFlag]=input.checked);const button=event.submitter;button.disabled=true;try{await api('/api/ai/platform-model-policy',{method:'PUT',body:JSON.stringify(payload)});toast('平台模型共享策略已保存','success');await loadPlatformModels()}catch(error){handleError(error);button.disabled=false}}
  document.querySelector('#saveAiFeatureFlags').onclick=async event=>{const flags={};document.querySelectorAll('[data-feature-flag]').forEach(input=>flags[input.dataset.featureFlag]=input.checked);event.currentTarget.disabled=true;try{await api('/api/ai/admin/feature-flags',{method:'PUT',body:JSON.stringify({flags})});toast('AI 功能开关已保存','success');await loadPlatformModels()}catch(error){handleError(error);event.currentTarget.disabled=false}}
  document.querySelectorAll('[data-rollout-rule]').forEach(select=>select.onchange=async()=>{select.disabled=true;try{await api(`/api/ai/admin/risk-rule-rollouts/${encodeURIComponent(select.dataset.rolloutRule)}`,{method:'PUT',body:JSON.stringify({mode:select.value})});toast('规则灰度状态已更新','success')}catch(error){handleError(error);await loadPlatformModels()}finally{select.disabled=false}})
  document.querySelector('#refreshAiGovernance').onclick=()=>loadPlatformModels().catch(handleError)
  document.querySelector('#rotateModelCredentials').onclick=async event=>{if(!await confirmAction('重新加密模型密钥？','系统会用当前主密钥重新加密全部模型凭证。运行期间已有请求不受影响。','确认轮换'))return;event.currentTarget.disabled=true;try{const result=await api('/api/ai/admin/credentials/rotate',{method:'POST'});toast(`密钥轮换完成：${Number(result.result?.rotatedCount||0)} 条`,'success');await loadPlatformModels()}catch(error){handleError(error);event.currentTarget.disabled=false}}
  document.querySelector('#clearLegacyCredentials').onclick=async event=>{if(!await confirmAction('清理旧明文凭证？','仅在所有迁移记录已验证后执行。清理后旧配置中的明文密钥无法恢复。','确认永久清理',true))return;event.currentTarget.disabled=true;try{await api('/api/ai/admin/credentials/finalize-legacy-cleanup',{method:'POST',body:JSON.stringify({confirm:'CLEAR_VERIFIED_LEGACY_CREDENTIALS'})});toast('旧明文凭证已清理','success');await loadPlatformModels()}catch(error){handleError(error);event.currentTarget.disabled=false}}
}
function audienceLabel(value) { return ({all:'全部用户',plus:'Plus 用户',pro:'Pro 用户',assigned:'指定用户'})[value] || '未设置' }
let entityModalReturnFocus=null
function closeEntityModal(){document.querySelector('#entityModal').hidden=true;entityModalReturnFocus?.focus?.();entityModalReturnFocus=null}
function openEntityModal({title,eyebrow='运营配置',content}){entityModalReturnFocus=document.activeElement;document.querySelector('#entityModalTitle').textContent=title;document.querySelector('#entityModalEyebrow').textContent=eyebrow;document.querySelector('#entityModalBody').innerHTML=content;document.querySelector('#entityModal').hidden=false}
async function loadObserverCandidates(){if(state.observerCandidates)return state.observerCandidates;const data=await api('/api/admin/ai/observer-candidates');state.observerCandidates=data;return data}
function openObserverSourceAccountEditor(){
  openEntityModal({title:'创建桥接源账号',eyebrow:'观摩源身份',content:`<form id="observerSourceAccountEditor" class="editor-form"><div class="form-grid"><label class="field"><span>显示名称</span><input class="input" id="observerAccountName" maxlength="100" placeholder="例如：二号观摩源"></label><label class="field"><span>登录邮箱</span><input class="input" id="observerAccountEmail" type="email" autocomplete="off" required placeholder="observer@example.com"></label><label class="field span-2"><span>初始密码</span><input class="input" id="observerAccountPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required><small class="helper">8 至 128 位，必须同时包含字母和数字。创建后可用该账号登录桥接软件。</small></label></div><div class="form-actions"><button class="secondary-button" data-close-entity-modal type="button">取消</button><button class="primary-button" type="submit">创建账号</button></div></form>`})
  const root=document.querySelector('#entityModalBody');root.querySelector('[data-close-entity-modal]').onclick=closeEntityModal
  root.querySelector('#observerSourceAccountEditor').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const result=await api('/api/admin/ai/observer-source-accounts',{method:'POST',body:JSON.stringify({nickname:root.querySelector('#observerAccountName').value.trim(),email:root.querySelector('#observerAccountEmail').value.trim(),password:root.querySelector('#observerAccountPassword').value})});state.observerCandidates=null;toast('桥接源账号已创建，请使用该账号登录新增的桥接窗口','success');closeEntityModal();await openObserverSourceEditor(null,Number(result.account.id))}catch(error){handleError(error);button.disabled=false}}
}
async function openObserverSourceEditor(source=null,preferredUserId=0){
  const data=await loadObserverCandidates(),selectedUserId=Number(preferredUserId||source?.bridge_user_id||data.candidates[0]?.id||0)
  const selectedUser=data.candidates.find(item=>Number(item.id)===selectedUserId)
  const accountOptions=user=>`<option value="">自动识别当前账户</option>${(user?.accounts||[]).map(account=>`<option value="${account.id}" ${Number(account.id)===Number(source?.trading_account_id)?'selected':''}>${escapeHtml(account.nickname||account.login_account)} · ${escapeHtml(account.broker_server||'MT5')}</option>`).join('')}`
  openEntityModal({title:source?'编辑观摩源':'新增观摩源',eyebrow:'AI 分析来源',content:`<form id="observerSourceEditor" class="editor-form"><div class="form-grid"><div class="field span-2"><label for="sourceName">来源名称</label><input class="input" id="sourceName" required maxlength="80" value="${escapeHtml(source?.name||'')}" placeholder="例如：稳健观摩源"></div><div class="field"><span class="field-heading"><label for="sourceUser">桥接源账号</label><button class="text-button mini-action" data-create-observer-account type="button">创建专用账号</button></span><select class="select" id="sourceUser" required>${data.candidates.map(user=>`<option value="${user.id}" ${Number(user.id)===selectedUserId?'selected':''}>${escapeHtml(user.nickname||user.email)} · ${user.bridge_online?'桥接在线':'桥接离线'}</option>`).join('')}</select></div><div class="field"><label for="sourceAccount">MT5 账户</label><select class="select" id="sourceAccount">${accountOptions(selectedUser)}</select></div><div class="field span-2"><label for="sourceStrategy">固定平台策略</label><select class="select" id="sourceStrategy" required><option value="">请选择平台策略</option>${data.strategies.map(strategy=>`<option value="${strategy.id}" ${Number(strategy.id)===Number(source?.strategy_id)?'selected':''}>${escapeHtml(strategy.title)} · 版本 ${strategy.version}</option>`).join('')}</select></div><div class="field"><label for="sourceStatus">来源状态</label><select class="select" id="sourceStatus"><option value="active" ${source?.status!=='inactive'?'selected':''}>启用</option><option value="inactive" ${source?.status==='inactive'?'selected':''}>停用</option></select></div><div class="field"><label>运行控制</label><div class="inline-checks"><label><input id="sourceAuto" type="checkbox" ${source?Number(source.auto_inference_enabled)?'checked':'':'checked'}> 自动分析</label><label><input id="sourceTrade" type="checkbox" ${source?Number(source.trade_send_enabled)?'checked':'':'checked'}> 交易发送</label></div></div><div class="field span-2"><label for="sourceNotes">备注</label><textarea class="input editor-textarea" id="sourceNotes" maxlength="255">${escapeHtml(source?.notes||'')}</textarea></div></div><div class="form-actions">${source?'<button class="text-button danger-text" data-delete-source type="button">删除来源</button>':''}<span class="action-spacer"></span><button class="secondary-button" data-close-entity-modal type="button">取消</button><button class="primary-button" type="submit">保存来源</button></div></form>`})
  const root=document.querySelector('#entityModalBody'),userSelect=root.querySelector('#sourceUser'),accountSelect=root.querySelector('#sourceAccount')
  userSelect.onchange=()=>{const user=data.candidates.find(item=>Number(item.id)===Number(userSelect.value));accountSelect.innerHTML=accountOptions(user)}
  root.querySelector('[data-close-entity-modal]').onclick=closeEntityModal
  root.querySelector('[data-create-observer-account]').onclick=openObserverSourceAccountEditor
  root.querySelector('[data-delete-source]')?.addEventListener('click',async()=>{if(!await confirmAction('删除观摩源？','仍绑定频道的来源不能删除。删除后，该来源不再生成或分发信号。','确认删除',true))return;await api(`/api/admin/ai/observer-sources/${source.id}`,{method:'DELETE'});toast('观摩源已删除','success');closeEntityModal();state.observerCandidates=null;await loadAiOperations(true)})
  root.querySelector('#observerSourceEditor').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const payload={name:root.querySelector('#sourceName').value.trim(),bridge_user_id:Number(userSelect.value),trading_account_id:accountSelect.value?Number(accountSelect.value):null,strategy_id:Number(root.querySelector('#sourceStrategy').value),status:root.querySelector('#sourceStatus').value,auto_inference_enabled:root.querySelector('#sourceAuto').checked,trade_send_enabled:root.querySelector('#sourceTrade').checked,notes:root.querySelector('#sourceNotes').value.trim()};await api(source?`/api/admin/ai/observer-sources/${source.id}`:'/api/admin/ai/observer-sources',{method:source?'PUT':'POST',body:JSON.stringify(payload)});toast('观摩源已保存','success');closeEntityModal();state.observerCandidates=null;await loadAiOperations(true)}catch(error){handleError(error)}finally{button.disabled=false}}
}
async function openObserverChannelEditor(channel=null){
  const sources=state.aiOperations?.observer?.sources||[]
  const assignments=channel?.audience==='assigned'?(await api(`/api/admin/ai/observer-channels/${channel.id}/assignments`)).assignments:[]
  openEntityModal({title:channel?'编辑观摩频道':'新增观摩频道',eyebrow:'观摩信号分发',content:`<form id="observerChannelEditor" class="editor-form"><div class="form-grid"><div class="field"><label for="channelName">频道名称</label><input class="input" id="channelName" required maxlength="80" value="${escapeHtml(channel?.name||'')}" placeholder="例如：稳健频道"></div><div class="field"><label for="channelSlug">频道标识</label><input class="input" id="channelSlug" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" value="${escapeHtml(channel?.slug||'')}" placeholder="steady"></div><div class="field"><label for="channelSource">对应观摩源</label><select class="select" id="channelSource" required>${sources.map(source=>`<option value="${source.id}" ${Number(source.id)===Number(channel?.source_id)?'selected':''}>${escapeHtml(source.name)}</option>`).join('')}</select></div><div class="field"><label for="channelAudience">开放范围</label><select class="select" id="channelAudience"><option value="all" ${channel?.audience==='all'||!channel?'selected':''}>全部观摩用户</option><option value="plus" ${channel?.audience==='plus'?'selected':''}>仅 Plus 用户</option><option value="pro" ${channel?.audience==='pro'?'selected':''}>仅 Pro 用户</option><option value="assigned" ${channel?.audience==='assigned'?'selected':''}>指定用户</option></select></div><div class="field span-2" id="channelAssignmentsField" ${channel?.audience==='assigned'?'':'hidden'}><label for="channelAssignments">指定用户 ID</label><input class="input" id="channelAssignments" value="${escapeHtml(assignments.map(item=>item.user_id).join(', '))}" placeholder="例如：12, 35, 68"><span class="helper">多个用户 ID 使用英文逗号分隔；选择“指定用户”时至少填写一个。</span></div><div class="field"><label for="channelStatus">频道状态</label><select class="select" id="channelStatus"><option value="active" ${channel?.status!=='inactive'?'selected':''}>启用</option><option value="inactive" ${channel?.status==='inactive'?'selected':''}>停用</option></select></div><div class="field"><label for="channelSort">排序值</label><input class="input" id="channelSort" type="number" min="0" value="${Number(channel?.sort_order||0)}"></div><div class="field span-2"><label for="channelDescription">频道说明</label><textarea class="input editor-textarea" id="channelDescription" maxlength="255">${escapeHtml(channel?.description||'')}</textarea></div><label class="inline-check span-2"><input id="channelDefault" type="checkbox" ${Number(channel?.is_default)?'checked':''}><span><strong>设为默认频道</strong><small>观摩用户未主动选择频道时使用</small></span></label></div><div class="form-actions">${channel&&!Number(channel.is_default)?'<button class="text-button danger-text" data-delete-channel type="button">删除频道</button>':''}<span class="action-spacer"></span><button class="secondary-button" data-close-entity-modal type="button">取消</button><button class="primary-button" type="submit">保存频道</button></div></form>`})
  const root=document.querySelector('#entityModalBody'),audience=root.querySelector('#channelAudience'),assignmentField=root.querySelector('#channelAssignmentsField');root.querySelector('[data-close-entity-modal]').onclick=closeEntityModal
  audience.onchange=()=>{assignmentField.hidden=audience.value!=='assigned'}
  root.querySelector('[data-delete-channel]')?.addEventListener('click',async()=>{if(!await confirmAction('删除观摩频道？','删除后用户将无法再选择此频道。','确认删除',true))return;await api(`/api/admin/ai/observer-channels/${channel.id}`,{method:'DELETE'});toast('观摩频道已删除','success');closeEntityModal();await loadAiOperations(true)})
  root.querySelector('#observerChannelEditor').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const payload={name:root.querySelector('#channelName').value.trim(),slug:root.querySelector('#channelSlug').value.trim(),source_id:Number(root.querySelector('#channelSource').value),audience:audience.value,status:root.querySelector('#channelStatus').value,sort_order:Number(root.querySelector('#channelSort').value||0),description:root.querySelector('#channelDescription').value.trim(),is_default:root.querySelector('#channelDefault').checked};const userIds=root.querySelector('#channelAssignments').value.split(',').map(value=>Number(value.trim())).filter(value=>Number.isInteger(value)&&value>0);if(payload.audience==='assigned'&&!userIds.length)throw new Error('指定用户频道至少需要一个用户 ID');const saved=await api(channel?`/api/admin/ai/observer-channels/${channel.id}`:'/api/admin/ai/observer-channels',{method:channel?'PUT':'POST',body:JSON.stringify(payload)});if(payload.audience==='assigned')await api(`/api/admin/ai/observer-channels/${saved.channel.id}/assignments`,{method:'PUT',body:JSON.stringify({user_ids:userIds})});toast('观摩频道已保存','success');closeEntityModal();await loadAiOperations(true)}catch(error){handleError(error)}finally{button.disabled=false}}
}
function aiObserverContent(data) {
  const sources = data.observer?.sources || []
  const channels = data.observer?.channels || []
  return `<section class="observer-admin-grid"><article class="panel"><header class="section-head"><div><h2>观摩源</h2><p>管理来源账号、固定策略和运行控制。</p></div><button class="secondary-button" data-new-observer-source type="button">新增来源</button></header><div class="observer-stack">${sources.length ? sources.map(source => `<article class="observer-source-row"><div class="observer-source-title"><span class="provider-dot ${source.bridge_online ? 'ok' : ''}"></span><div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.strategy_title || '未绑定策略')} · ${source.bridge_online ? '桥接在线' : '桥接离线'}</small></div></div><div class="runtime-switches"><label><input type="checkbox" data-source-toggle="auto" data-source-id="${Number(source.id)}" ${Number(source.auto_inference_enabled) ? 'checked' : ''}><span>自动分析</span></label><label><input type="checkbox" data-source-toggle="trade" data-source-id="${Number(source.id)}" ${Number(source.trade_send_enabled) ? 'checked' : ''}><span>交易发送</span></label><button class="icon-button compact-icon" data-edit-observer-source="${Number(source.id)}" type="button" aria-label="编辑观摩源 ${escapeHtml(source.name)}"><span data-icon="more"></span></button></div></article>`).join('') : '<div class="empty-state">还没有配置观摩源</div>'}</div></article>
    <article class="panel"><header class="section-head"><div><h2>频道分发</h2><p>管理默认频道、开放范围与对应来源。</p></div><button class="secondary-button" data-new-observer-channel type="button" ${sources.length?'':'disabled'}>新增频道</button></header><div class="observer-stack">${channels.length ? channels.map(channel => `<article class="channel-row"><div><div class="channel-name"><strong>${escapeHtml(channel.name)}</strong>${Number(channel.is_default) ? '<span class="badge active">默认</span>' : ''}</div><small>${escapeHtml(channel.source_name || '未绑定来源')} · ${audienceLabel(channel.audience)}</small></div><div class="row-actions"><span class="badge ${channel.status === 'active' && channel.source_status === 'active' ? 'active' : 'expired'}">${channel.status === 'active' && channel.source_status === 'active' ? '可用' : '停用'}</span><button class="icon-button compact-icon" data-edit-observer-channel="${Number(channel.id)}" type="button" aria-label="编辑观摩频道 ${escapeHtml(channel.name)}"><span data-icon="more"></span></button></div></article>`).join('') : '<div class="empty-state">还没有配置观摩频道</div>'}</div></article></section>`
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
  document.querySelector('[data-new-observer-source]')?.addEventListener('click',()=>openObserverSourceEditor().catch(handleError))
  document.querySelector('[data-new-observer-channel]')?.addEventListener('click',()=>openObserverChannelEditor().catch(handleError))
  document.querySelectorAll('[data-edit-observer-source]').forEach(button=>button.addEventListener('click',()=>{const source=state.aiOperations.observer.sources.find(item=>Number(item.id)===Number(button.dataset.editObserverSource));openObserverSourceEditor(source).catch(handleError)}))
  document.querySelectorAll('[data-edit-observer-channel]').forEach(button=>button.addEventListener('click',()=>{const channel=state.aiOperations.observer.channels.find(item=>Number(item.id)===Number(button.dataset.editObserverChannel));openObserverChannelEditor(channel).catch(handleError)}))
}
function renderAiOperationsContent() {
  const content = document.querySelector('#aiOperationsContent')
  if (!content) return
  if (state.aiTab === 'models') {
    renderPlatformModels()
    if (!state.platformModels.policy || !state.platformModels.governance) loadPlatformModels().catch(handleError)
    document.querySelectorAll('[data-ai-tab]').forEach(button => button.classList.toggle('is-active', button.dataset.aiTab === state.aiTab))
    return
  }
  if (state.aiTab === 'model-compare') {
    renderModelCompareContent()
    if (!state.modelCompare.setup) loadModelCompareWorkspace().catch(handleError)
    return
  }
  clearTimeout(state.modelCompare.polling)
  state.modelCompare.polling = null
  if (!state.aiOperations) return
  if (state.aiTab === 'scheduler') content.innerHTML = aiSchedulerContent(state.aiOperations)
  else if (state.aiTab === 'observer') content.innerHTML = aiObserverContent(state.aiOperations)
  else content.innerHTML = aiHealthContent(state.aiOperations)
  renderIcons(content)
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
  main.innerHTML = `<header class="page-head"><div><span class="eyebrow">模型、调度与观摩分发</span><h1>AI 运营治理</h1><p>先确认核心链路是否健康，再处理调度、模型和观摩频道。</p></div></header>${aiTabs()}<div id="aiOperationsContent"></div>`
  bindAiTabs()
  if (state.aiTab === 'models') await loadPlatformModels()
  else if (state.aiTab === 'model-compare') await loadModelCompareWorkspace()
  else await loadAiOperations()
}

function riskTabs() { return `<nav class="segment-tabs" aria-label="风控与审计分类"><button class="segment-tab ${state.riskTab === 'status' ? 'is-active' : ''}" data-risk-tab="status" type="button">风险状态</button><button class="segment-tab ${state.riskTab === 'rules' ? 'is-active' : ''}" data-risk-tab="rules" type="button">平台规则</button><button class="segment-tab ${state.riskTab === 'decisions' ? 'is-active' : ''}" data-risk-tab="decisions" type="button">执行决策</button><button class="segment-tab ${state.riskTab === 'audit' ? 'is-active' : ''}" data-risk-tab="audit" type="button">管理审计</button></nav>` }
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
const riskGroupLabels={account:'账户与仓位',platform:'平台执行边界',system:'系统强制保护'}
function riskValueControl(key,meta,value,disabled=false){
  if(meta.type==='boolean')return `<select class="select" data-risk-value="${key}" ${disabled?'disabled':''}><option value="true" ${value?'selected':''}>开启</option><option value="false" ${!value?'selected':''}>关闭</option></select>`
  if(meta.type==='set')return `<input class="input" data-risk-value="${key}" value="${escapeHtml((value||[]).join(', '))}" ${disabled?'disabled':''}>`
  return `<div class="unit-input"><input class="input" type="number" step="any" min="${meta.allowed_min}" max="${meta.allowed_max}" data-risk-value="${key}" value="${escapeHtml(value)}" ${disabled?'disabled':''}><span>${escapeHtml(meta.unit_label||meta.unit||'')}</span></div>`
}
function renderRiskRuleRow(key,meta,policy){
  const control=policy.controls[key]||{}
  const managed=meta.user_editable&&!meta.locked&&meta.type==='number'
  return `<article class="risk-rule-card"><header><div><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.description||'平台交易安全规则')}</small></div><span class="badge">${escapeHtml(meta.unit_label||'规则')}</span></header><div class="risk-rule-grid"><label><span>平台默认值</span>${riskValueControl(key,meta,policy.values[key],meta.locked)}</label>${managed?`<label><span>用户可选最小值</span><div class="unit-input"><input class="input" type="number" step="any" data-risk-min="${key}" value="${escapeHtml(control.allowed_min)}"><span>${escapeHtml(meta.unit_label||'')}</span></div></label><label><span>用户可选最大值</span><div class="unit-input"><input class="input" type="number" step="any" data-risk-max="${key}" value="${escapeHtml(control.allowed_max)}"><span>${escapeHtml(meta.unit_label||'')}</span></div></label><label><span>平台锁定值</span><div class="unit-input"><input class="input" type="number" step="any" data-risk-lock="${key}" value="${control.locked_value??''}" placeholder="不锁定"><span>${escapeHtml(meta.unit_label||'')}</span></div></label>`:`<div class="risk-rule-fixed"><strong>${meta.locked?'系统强制执行':'仅平台管理'}</strong><small>${meta.locked?'不能被用户或策略关闭':'普通用户不可修改此规则'}</small></div>`}</div></article>`
}
function renderPlatformRiskPolicy(){
  const root=document.querySelector('#riskContent'),policy=state.riskPolicy
  if(!root||!policy)return
  const grouped={account:[],platform:[],system:[]}
  Object.entries(policy.rule_metadata||{}).forEach(([key,meta])=>(grouped[meta.category]||grouped.account).push([key,meta]))
  root.innerHTML=`<form id="platformRiskForm"><section class="risk-policy-toolbar"><div><span class="eyebrow">当前生效版本</span><strong>版本 ${policy.version?.version_no||'默认'}</strong><small>保存后立即生效，并保留完整版本记录。</small></div><div class="field"><label for="riskChangeReason">本次调整说明</label><input class="input" id="riskChangeReason" maxlength="120" placeholder="例如：调整账户风险上限"></div><button class="primary-button" type="submit">保存并立即生效</button></section><div class="risk-policy-groups">${Object.entries(grouped).map(([group,rows])=>`<details class="risk-policy-group" data-risk-policy-group="${group}" ${state.riskOpenGroup===group?'open':''}><summary><span><strong>${riskGroupLabels[group]}</strong><small>${rows.length} 项规则</small></span><span>展开管理</span></summary><div class="risk-policy-list">${rows.map(([key,meta])=>renderRiskRuleRow(key,meta,policy)).join('')}</div></details>`).join('')}</div></form>`
  root.querySelectorAll('[data-risk-policy-group]').forEach(detail=>detail.addEventListener('toggle',()=>{if(detail.open)state.riskOpenGroup=detail.dataset.riskPolicyGroup}))
  document.querySelector('#platformRiskForm').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true
    try{const values={},controls={};root.querySelectorAll('[data-risk-value]').forEach(input=>{const meta=policy.rule_metadata[input.dataset.riskValue];values[input.dataset.riskValue]=meta.type==='boolean'?input.value==='true':meta.type==='set'?input.value.split(',').map(v=>v.trim()).filter(Boolean):Number(input.value)});root.querySelectorAll('[data-risk-min]').forEach(input=>{controls[input.dataset.riskMin]||={};controls[input.dataset.riskMin].allowed_min=Number(input.value)});root.querySelectorAll('[data-risk-max]').forEach(input=>{controls[input.dataset.riskMax]||={};controls[input.dataset.riskMax].allowed_max=Number(input.value)});root.querySelectorAll('[data-risk-lock]').forEach(input=>{controls[input.dataset.riskLock]||={};controls[input.dataset.riskLock].locked_value=input.value===''?null:Number(input.value)});await api('/api/admin/risk-audit/platform-policy',{method:'PUT',body:JSON.stringify({values,controls,reason:document.querySelector('#riskChangeReason').value.trim()})});toast('平台风控规则已立即生效','success');await loadPlatformRiskPolicy()}catch(error){handleError(error)}finally{button.disabled=false}}
}
async function loadPlatformRiskPolicy(){const data=await api('/api/admin/risk-audit/platform-policy');state.riskPolicy=data.policy;renderPlatformRiskPolicy()}
function renderRiskContent(){const root=document.querySelector('#riskContent');if(!root||!state.riskData)return;if(state.riskTab==='decisions')root.innerHTML=riskDecisionsContent(state.riskData);else root.innerHTML=riskStatusContent(state.riskData);if(state.riskTab==='status')bindRiskStatus();if(state.riskTab==='decisions'){const select=document.querySelector('#riskDecision');select.value=state.riskDecision;document.querySelector('#riskDecisionFilter').onsubmit=e=>{e.preventDefault();state.riskDecision=select.value;state.riskPage=1;loadRiskAudit().catch(handleError)};const p=state.riskData.pagination;document.querySelector('#riskPrev').disabled=p.page<=1;document.querySelector('#riskNext').disabled=p.page>=p.total_pages;document.querySelector('#riskPrev').onclick=()=>{state.riskPage--;loadRiskAudit().catch(handleError)};document.querySelector('#riskNext').onclick=()=>{state.riskPage++;loadRiskAudit().catch(handleError)}}}
async function renderRiskAudit(){const main=document.querySelector('#adminMain');main.innerHTML=`<header class="page-head"><div><span class="eyebrow">交易安全与操作追溯</span><h1>风控与审计</h1><p>先确认平台和账户能否交易，再管理规则并追溯每次决策。</p></div></header>${riskTabs()}<div id="riskContent"><div class="panel"><div class="empty-state">正在读取风控状态…</div></div></div>`;document.querySelectorAll('[data-risk-tab]').forEach(button=>button.onclick=async()=>{state.riskTab=button.dataset.riskTab;document.querySelectorAll('[data-risk-tab]').forEach(item=>item.classList.toggle('is-active',item===button));if(state.riskTab==='audit')await renderAuditEvents();else if(state.riskTab==='rules')await loadPlatformRiskPolicy();else {if(!state.riskData)await loadRiskAudit();else renderRiskContent()}});if(state.riskTab==='rules')await loadPlatformRiskPolicy();else if(state.riskTab==='audit')await renderAuditEvents();else await loadRiskAudit()}

function contentTabs(){return `<nav class="segment-tabs" aria-label="内容与系统分类"><button class="segment-tab ${state.contentTab==='courses'?'is-active':''}" data-content-tab="courses" type="button">课程内容</button><button class="segment-tab ${state.contentTab==='assets'?'is-active':''}" data-content-tab="assets" type="button">测验与资料</button><button class="segment-tab ${state.contentTab==='feedback'?'is-active':''}" data-content-tab="feedback" type="button">用户反馈</button><button class="segment-tab ${state.contentTab==='system'?'is-active':''}" data-content-tab="system" type="button">系统发布</button></nav>`}
const courseStatusLabels={published:'已发布',draft:'草稿',archived:'已归档'}
const accessLabels={free:'公开免费',logged_in:'登录可看',plus_pro:'Plus / Pro',pro_only:'仅 Pro'}
const courseCategoryLabels={morning:'早盘解读',indicator:'技术指标',pattern:'形态分析',strategy:'交易策略',advanced:'经济指标'}
let courseModalReturnFocus=null
function closeCourseEditor(){
  document.querySelector('#contentModal').hidden=true
  courseModalReturnFocus?.focus?.()
  courseModalReturnFocus=null
}
function courseEditorMarkup(course={}) {
  const selected=(value,current)=>value===current?'selected':''
  return `<form id="courseEditorForm" class="editor-form">
    <input type="hidden" id="courseId" value="${escapeHtml(course.id||'')}">
    <section class="editor-section"><div class="editor-section-head"><div><h3>基础信息</h3><p>标题、栏目和发布状态决定课程在主站中的展示位置。</p></div></div><div class="form-grid">
      <div class="field span-2"><label for="courseTitle">课程标题</label><input class="input" id="courseTitle" required maxlength="200" value="${escapeHtml(course.title||'')}" placeholder="输入面向用户的课程标题"></div>
      <div class="field span-2"><label for="courseDescription">课程说明</label><textarea class="input editor-textarea" id="courseDescription" maxlength="2000" placeholder="简要说明本节内容与学习目标">${escapeHtml(course.description||'')}</textarea></div>
      <div class="field"><label for="courseCategory">发布栏目</label><select class="select" id="courseCategory" required>${Object.entries(courseCategoryLabels).map(([value,label])=>`<option value="${value}" ${selected(value,course.category||'morning')}>${label}</option>`).join('')}</select></div>
      <div class="field"><label for="courseContentType">内容类型</label><select class="select" id="courseContentType"><option value="video" ${selected('video',course.content_type||'video')}>视频课程</option><option value="article" ${selected('article',course.content_type)}>文章课程</option></select></div>
      <div class="field"><label for="courseStatus">发布状态</label><select class="select" id="courseStatus"><option value="draft" ${selected('draft',course.status||'draft')}>草稿</option><option value="published" ${selected('published',course.status)}>已发布</option><option value="archived" ${selected('archived',course.status)}>已归档</option></select></div>
      <div class="field"><label for="courseAccess">访问权限</label><select class="select" id="courseAccess">${Object.entries(accessLabels).map(([value,label])=>`<option value="${value}" ${selected(value,course.access_level||'free')}>${label}</option>`).join('')}</select></div>
      <div class="field"><label for="courseNumber">展示编号</label><input class="input" id="courseNumber" type="number" min="0" value="${escapeHtml(course.number||'')}"></div>
      <div class="field"><label for="courseSortOrder">排序值</label><input class="input" id="courseSortOrder" type="number" min="0" value="${escapeHtml(course.sort_order||0)}"></div>
    </div></section>
    <section class="editor-section"><div class="editor-section-head"><div><h3>内容来源</h3><p>只填写当前课程实际使用的来源；未填写的来源不会出现在前台。</p></div></div><div class="form-grid">
      <div class="field"><label for="courseBilibili">哔哩哔哩视频编号</label><input class="input" id="courseBilibili" value="${escapeHtml(course.bilibili_id||'')}" placeholder="BV..."></div>
      <div class="field"><label for="courseYoutube">YouTube 视频编号</label><input class="input" id="courseYoutube" value="${escapeHtml(course.youtube_id||'')}" placeholder="视频编号"></div>
      <div class="field"><label for="courseDuration">课程时长</label><input class="input" id="courseDuration" value="${escapeHtml(course.duration||'')}" placeholder="例如 18:30"></div>
      <div class="field"><label for="courseCover">封面地址</label><input class="input" id="courseCover" value="${escapeHtml(course.cover||'')}" placeholder="https://..."></div>
      <div class="field span-2"><label for="courseArticleUrl">文章地址</label><input class="input" id="courseArticleUrl" value="${escapeHtml(course.article_url||'')}" placeholder="文章课程使用"></div>
    </div></section>
    <div class="form-actions editor-actions">${course.id?'<button class="text-button danger-text" data-delete-course type="button">删除课程</button>':''}<span class="action-spacer"></span><button class="secondary-button" data-close-content-modal type="button">取消</button><button class="primary-button" type="submit">${course.id?'保存修改':'创建课程'}</button></div>
  </form>`
}
async function openCourseEditor(courseId=null) {
  courseModalReturnFocus=document.activeElement
  const modal=document.querySelector('#contentModal')
  const body=document.querySelector('#contentModalBody')
  modal.hidden=false
  body.innerHTML='<div class="empty-state">正在读取课程资料…</div>'
  try {
    const course=courseId?(await api(`/api/admin/content-system/courses/${encodeURIComponent(courseId)}`)).course:{}
    document.querySelector('#contentModalTitle').textContent=course.id?'编辑课程':'新建课程'
    body.innerHTML=courseEditorMarkup(course)
    body.querySelectorAll('[data-close-content-modal]').forEach(button=>button.onclick=closeCourseEditor)
    body.querySelector('[data-delete-course]')?.addEventListener('click',async()=>{
      if(!await confirmAction('删除这门课程？','课程、测试、资源、学习进度和评论都会被永久删除，无法恢复。','确认永久删除',true))return
      await api(`/api/admin/content-system/courses/${course.id}`,{method:'DELETE'})
      toast('课程已删除','success');closeCourseEditor();await renderContentCourses()
    })
    body.querySelector('#courseEditorForm').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true
      const payload={id:course.id||undefined,title:body.querySelector('#courseTitle').value.trim(),description:body.querySelector('#courseDescription').value.trim(),category:body.querySelector('#courseCategory').value,content_type:body.querySelector('#courseContentType').value,status:body.querySelector('#courseStatus').value,access_level:body.querySelector('#courseAccess').value,number:Number(body.querySelector('#courseNumber').value||0),sort_order:Number(body.querySelector('#courseSortOrder').value||0),bilibili_id:body.querySelector('#courseBilibili').value.trim(),youtube_id:body.querySelector('#courseYoutube').value.trim(),duration:body.querySelector('#courseDuration').value.trim(),cover:body.querySelector('#courseCover').value.trim(),article_url:body.querySelector('#courseArticleUrl').value.trim()}
      try{await api('/api/admin/content-system/courses',{method:'POST',body:JSON.stringify(payload)});toast(course.id?'课程已保存':'课程已创建','success');closeCourseEditor();await renderContentCourses()}catch(error){handleError(error)}finally{button.disabled=false}
    }
    body.querySelector('#courseTitle').focus()
  } catch(error){body.innerHTML=`<div class="empty-state">${escapeHtml(error.message)}</div>`}
}
async function renderContentCourses() {
  const params=new URLSearchParams({page:String(state.contentPage),page_size:'20',status:state.contentStatus})
  if(state.contentSearch)params.set('search',state.contentSearch)
  const data=await api(`/api/admin/content-system/courses?${params}`)
  document.querySelector('#contentSystemBody').innerHTML=`<section class="panel"><form class="filter-bar" id="courseFilters"><div class="field"><label for="contentSearch">搜索课程</label><input class="input" id="contentSearch" value="${escapeHtml(state.contentSearch)}" placeholder="课程名称、说明或分类"></div><div class="field"><label for="contentStatus">发布状态</label><select class="select" id="contentStatus"><option value="all">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option><option value="archived">已归档</option></select></div><button class="primary-button" data-new-course type="button">新建课程</button></form><div class="content-card-list">${data.courses.map(course=>`<button class="content-card" data-edit-course="${course.id}" type="button"><div class="content-card-index">${String(course.number||course.id).padStart(2,'0')}</div><div class="content-card-main"><div><strong>${escapeHtml(course.title)}</strong><span class="badge ${course.status==='published'?'active':''}">${courseStatusLabels[course.status]||'未知状态'}</span></div><small>${escapeHtml(course.category||'未分类')} · ${course.content_type==='article'?'文章':'视频'} · ${accessLabels[course.access_level]||course.access_level}</small><p>测试 ${course.quiz_count} · 思维导图 ${course.mindmap_count} · 知识点 ${course.knowledge_count}</p></div><span class="content-card-action">编辑</span></button>`).join('')||'<div class="empty-state">没有符合条件的课程</div>'}</div><div class="pagination"><button class="secondary-button" id="contentPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="contentNext" type="button">下一页</button></div></section>`
  const status=document.querySelector('#contentStatus');status.value=state.contentStatus
  document.querySelector('#courseFilters').onsubmit=e=>e.preventDefault()
  status.onchange=()=>{state.contentStatus=status.value;state.contentPage=1;renderContentCourses().catch(handleError)}
  document.querySelector('#contentSearch').onchange=e=>{state.contentSearch=e.target.value.trim();state.contentPage=1;renderContentCourses().catch(handleError)}
  document.querySelector('[data-new-course]').onclick=()=>openCourseEditor()
  document.querySelectorAll('[data-edit-course]').forEach(button=>button.onclick=()=>openCourseEditor(button.dataset.editCourse))
  document.querySelector('#contentPrev').disabled=data.pagination.page<=1
  document.querySelector('#contentNext').disabled=data.pagination.page>=data.pagination.total_pages
  document.querySelector('#contentPrev').onclick=()=>{state.contentPage--;renderContentCourses().catch(handleError)}
  document.querySelector('#contentNext').onclick=()=>{state.contentPage++;renderContentCourses().catch(handleError)}
}
function courseResourceTypeLabel(resource){if(resource.type==='mindmap')return resource.structure?'结构导图':'导图图片';if(resource.type==='knowledge')return '信息图';return resource.type||'课程资料'}
function courseAssetWorkspace() {
  const asset=state.courseAssets,course=asset.courses.find(item=>Number(item.id)===Number(asset.episodeId)),resources=asset.resources?.resources||[],questions=asset.questions||[],editing=asset.editingQuestion||{}
  return `<section class="course-asset-workspace"><article class="panel asset-course-picker"><header class="section-head"><div><span class="eyebrow">课程选择</span><h2>测验与配套资料</h2><p>选择课程后，统一管理题目、导图和信息图。</p></div></header><div class="panel-body"><label class="field"><span>当前课程</span><select class="select" id="assetCourseSelect">${asset.courses.map(item=>`<option value="${item.id}" ${Number(item.id)===Number(asset.episodeId)?'selected':''}>${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="asset-summary"><span>题目<strong>${Number(asset.resources?.quizCount||0)}</strong></span><span>课程资料<strong>${resources.length}</strong></span><span>课程编号<strong>${course?.number||course?.id||'--'}</strong></span></div></div></article><section class="course-asset-grid"><article class="panel"><header class="section-head"><div><h2>批量导入资料</h2><p>支持 NotebookLM 导出的题目 JSON、导图 JSON 与图片。</p></div></header><form class="asset-upload-form" id="courseAssetUpload"><label class="file-drop"><input id="courseAssetFiles" type="file" multiple accept=".json,application/json,image/png,image/jpeg,image/webp,image/svg+xml"><span><strong>选择 JSON 或图片文件</strong><small id="courseAssetFileLabel">最多 50 个文件；服务端按文件名与内容自动识别</small></span></label><div class="asset-type-checks"><label><input type="checkbox" id="assetIncludeQuiz" checked> 导入测验题目</label><label><input type="checkbox" id="assetIncludeMindmap" checked> 导入思维导图</label><label><input type="checkbox" id="assetIncludeInfographic" checked> 导入信息图</label></div><button class="primary-button" type="submit">上传并解析</button></form><div class="resource-list">${resources.map(resource=>`<article><span class="badge">${escapeHtml(courseResourceTypeLabel(resource))}</span><div><strong>${escapeHtml(resource.title||'未命名资料')}</strong><small>${escapeHtml(resource.url||'结构化数据')}</small></div></article>`).join('')||'<div class="empty-state compact-empty">该课程还没有配套资料</div>'}</div></article><article class="panel"><header class="section-head"><div><h2>${editing.id?'编辑题目':'新增题目'}</h2><p>正确选项按从 1 开始的序号填写。</p></div>${editing.id?'<button class="text-button" id="cancelQuizEdit" type="button">取消编辑</button>':''}</header><form class="quiz-editor" id="quizEditor"><label class="field"><span>题干</span><textarea class="input editor-textarea" id="quizQuestion" required>${escapeHtml(editing.question||'')}</textarea></label><label class="field"><span>选项（每行一个）</span><textarea class="input editor-textarea" id="quizOptions" required>${escapeHtml((editing.options||[]).join('\n'))}</textarea></label><div class="quiz-form-grid"><label class="field"><span>正确选项序号</span><input class="input" id="quizAnswer" type="number" min="1" value="${Number(editing.answer??0)+1}"></label><label class="field"><span>排序值</span><input class="input" id="quizSort" type="number" min="0" value="${Number(editing.sortOrder||questions.length)}"></label><label class="field"><span>状态</span><select class="select" id="quizStatus"><option value="published" ${editing.status!=='draft'?'selected':''}>已发布</option><option value="draft" ${editing.status==='draft'?'selected':''}>草稿</option></select></label></div><label class="field"><span>通用解释</span><textarea class="input" id="quizExplanation">${escapeHtml(editing.explanation||'')}</textarea></label><label class="field"><span>答题提示</span><textarea class="input" id="quizHint">${escapeHtml(editing.hint||'')}</textarea></label><button class="primary-button" type="submit">${editing.id?'保存题目':'添加题目'}</button></form></article></section><article class="panel"><header class="section-head"><div><h2>题目列表</h2><p>共 ${questions.length} 道题；发布状态决定用户是否可见。</p></div></header><div class="quiz-list">${questions.map((question,index)=>`<article class="quiz-row" data-quiz-id="${question.id}"><span class="quiz-index">${index+1}</span><div><strong>${escapeHtml(question.question)}</strong><small>${question.options.length} 个选项 · 正确答案 ${Number(question.answer)+1} · ${question.status==='draft'?'草稿':'已发布'}</small></div><button class="text-button" data-edit-quiz type="button">编辑</button><button class="text-button danger-text" data-delete-quiz type="button">删除</button></article>`).join('')||'<div class="empty-state compact-empty">该课程还没有测验题目</div>'}</div></article></section>`
}
async function loadCourseAssets() {
  const asset=state.courseAssets
  if(!asset.courses.length){const data=await api('/api/admin/content-system/courses?page=1&page_size=100&status=all');asset.courses=data.courses||[];asset.episodeId=Number(asset.episodeId||asset.courses[0]?.id||0)}
  if(!asset.episodeId){document.querySelector('#contentSystemBody').innerHTML='<div class="panel"><div class="empty-state">请先创建一门课程</div></div>';return}
  const [resources,quiz]=await Promise.all([api(`/api/admin-course-resources?episode=${asset.episodeId}`),api(`/api/admin-quiz?episode=${asset.episodeId}`)])
  asset.resources=resources;asset.questions=quiz.questions||[]
  renderCourseAssets()
}
function renderCourseAssets() {
  const root=document.querySelector('#contentSystemBody');root.innerHTML=courseAssetWorkspace();const asset=state.courseAssets
  root.querySelector('#assetCourseSelect').onchange=async event=>{asset.episodeId=Number(event.target.value);asset.editingQuestion=null;await loadCourseAssets().catch(handleError)}
  root.querySelector('#courseAssetFiles').onchange=event=>{const count=event.target.files.length;root.querySelector('#courseAssetFileLabel').textContent=count?`已选择 ${count} 个文件`:'最多 50 个文件；服务端按文件名与内容自动识别'}
  root.querySelector('#courseAssetUpload').onsubmit=async event=>{event.preventDefault();const files=[...root.querySelector('#courseAssetFiles').files];if(!files.length)return handleError(new Error('请选择要导入的 JSON 或图片文件'));const button=event.submitter,form=new FormData();form.append('episodeId',String(asset.episodeId));form.append('includeQuiz',root.querySelector('#assetIncludeQuiz').checked?'1':'0');form.append('includeMindmap',root.querySelector('#assetIncludeMindmap').checked?'1':'0');form.append('includeInfographic',root.querySelector('#assetIncludeInfographic').checked?'1':'0');files.forEach(file=>form.append('files',file,file.webkitRelativePath||file.name));button.disabled=true;try{const result=await api('/api/admin-course-resources',{method:'POST',body:form});const skipped=Array.isArray(result.skipped)?result.skipped.length:0;toast(`导入完成：题库文件 ${Number(result.quizFiles||0)}，资料文件 ${Number(result.assetFiles||0)}${skipped?`，跳过 ${skipped}`:''}`,'success');await loadCourseAssets()}catch(error){handleError(error);button.disabled=false}}
  root.querySelector('#cancelQuizEdit')?.addEventListener('click',()=>{asset.editingQuestion=null;renderCourseAssets()})
  root.querySelector('#quizEditor').onsubmit=async event=>{event.preventDefault();const options=root.querySelector('#quizOptions').value.split('\n').map(value=>value.trim()).filter(Boolean);if(options.length<2)return handleError(new Error('一道题至少需要 2 个选项'));const correctIndex=Number(root.querySelector('#quizAnswer').value)-1;if(correctIndex<0||correctIndex>=options.length)return handleError(new Error('正确选项序号超出选项范围'));const button=event.submitter;button.disabled=true;try{await api('/api/admin-quiz',{method:'POST',body:JSON.stringify({id:asset.editingQuestion?.id||undefined,episodeId:asset.episodeId,question:root.querySelector('#quizQuestion').value.trim(),options,correctIndex,explanation:root.querySelector('#quizExplanation').value.trim(),explanations:[],hint:root.querySelector('#quizHint').value.trim(),status:root.querySelector('#quizStatus').value,sortOrder:Number(root.querySelector('#quizSort').value||0)})});toast(asset.editingQuestion?'题目已保存':'题目已添加','success');asset.editingQuestion=null;await loadCourseAssets()}catch(error){handleError(error);button.disabled=false}}
  root.querySelectorAll('[data-edit-quiz]').forEach(button=>button.onclick=()=>{const id=Number(button.closest('[data-quiz-id]').dataset.quizId);asset.editingQuestion=asset.questions.find(item=>Number(item.id)===id)||null;renderCourseAssets();root.querySelector('#quizQuestion')?.focus()})
  root.querySelectorAll('[data-delete-quiz]').forEach(button=>button.onclick=async()=>{const id=Number(button.closest('[data-quiz-id]').dataset.quizId);if(!await confirmAction('删除这道题？','删除后无法恢复，但不会影响课程主体和其他资料。','确认删除',true))return;try{await api(`/api/admin-quiz?id=${id}`,{method:'DELETE'});toast('题目已删除','success');await loadCourseAssets()}catch(error){handleError(error)}})
}
async function renderContentFeedback(){const params=new URLSearchParams({page:String(state.feedbackPage),page_size:'20'});if(state.feedbackSearch)params.set('search',state.feedbackSearch);const data=await api(`/api/admin/content-system/feedback?${params}`);document.querySelector('#contentSystemBody').innerHTML=`<section class="panel"><form class="filter-bar compact-filter" id="feedbackFilters"><div class="field"><label for="feedbackSearch">搜索反馈</label><input class="input" id="feedbackSearch" value="${escapeHtml(state.feedbackSearch)}" placeholder="标题、内容、联系方式或用户"></div><button class="secondary-button" type="submit">搜索</button></form><div class="feedback-list">${data.feedback.map(item=>`<article class="feedback-card"><header><div><span class="badge">${escapeHtml(item.type||'建议')}</span><strong>${escapeHtml(item.title)}</strong></div><time>${formatDate(item.created_at,true)}</time></header><p>${escapeHtml(item.description)}</p><footer>${escapeHtml(item.user_nickname||item.user_email||'匿名用户')} · ${escapeHtml(item.contact||'未留联系方式')}</footer></article>`).join('')||'<div class="empty-state">暂无用户反馈</div>'}</div><div class="pagination"><button class="secondary-button" id="feedbackPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="feedbackNext" type="button">下一页</button></div></section>`;document.querySelector('#feedbackFilters').onsubmit=e=>{e.preventDefault();state.feedbackSearch=document.querySelector('#feedbackSearch').value.trim();state.feedbackPage=1;renderContentFeedback().catch(handleError)};document.querySelector('#feedbackPrev').disabled=data.pagination.page<=1;document.querySelector('#feedbackNext').disabled=data.pagination.page>=data.pagination.total_pages;document.querySelector('#feedbackPrev').onclick=()=>{state.feedbackPage--;renderContentFeedback().catch(handleError)};document.querySelector('#feedbackNext').onclick=()=>{state.feedbackPage++;renderContentFeedback().catch(handleError)}}
const systemCategoryLabels={plan_prices:'套餐价格',smtp:'发件邮箱',qiniu:'文件存储',toolbox:'金融工具箱',market_menu:'股票研究菜单',sms:'短信服务',auth_toggle:'登录与注册',crypto_wallet:'收款钱包',changelog:'版本说明'}
function systemConfigInput(item) {
  const value=String(item.value??'')
  const redacted=value==='***REDACTED***'
  const isBoolean=['true','false'].includes(value)
  const isJson=['items'].includes(item.key)||value.trim().startsWith('[')||value.trim().startsWith('{')
  if(redacted)return `<input class="input" type="password" data-config-key="${escapeHtml(item.key)}" data-redacted="true" value="" placeholder="已安全配置；留空保持不变">`
  if(isBoolean)return `<select class="select" data-config-key="${escapeHtml(item.key)}"><option value="true" ${value==='true'?'selected':''}>开启</option><option value="false" ${value==='false'?'selected':''}>关闭</option></select>`
  if(isJson)return `<textarea class="input config-json-input" data-config-key="${escapeHtml(item.key)}" spellcheck="false">${escapeHtml(value)}</textarea>`
  return `<input class="input" data-config-key="${escapeHtml(item.key)}" value="${escapeHtml(value)}">`
}
function systemCategoryTools(category) {
  if(category==='smtp')return `<section class="config-action-panel"><div><span class="eyebrow">配置验证</span><strong>发送测试邮件</strong><small>保存配置后，向指定邮箱发送一封测试邮件。</small></div><div class="config-action-form"><input class="input" id="smtpTestTarget" type="email" placeholder="收件邮箱"><button class="secondary-button" id="smtpTestSend" type="button">发送测试</button></div></section>`
  if(category==='sms')return `<section class="config-action-panel"><div><span class="eyebrow">配置验证</span><strong>发送测试短信</strong><small>验证码、到期提醒和已过期提醒使用不同模板。</small></div><div class="config-action-form sms-action-form"><input class="input" id="smsTestTarget" type="tel" placeholder="测试手机号"><select class="select" id="smsTestTemplate"><option value="verification">验证码模板</option><option value="membership_expiry">会员到期提醒</option><option value="membership_expired">会员已过期提醒</option></select><button class="secondary-button" id="smsTestSend" type="button">发送测试</button></div></section>`
  if(category==='crypto_wallet')return `<section class="config-action-panel crypto-operation-panel"><div><span class="eyebrow">链上资金操作</span><strong>支付模式与地址归集</strong><small>归集会发起真实链上交易，执行前必须再次确认。</small></div><div id="cryptoOperations"><div class="empty-inline">正在读取链上地址与余额…</div></div></section>`
  return ''
}
async function loadCryptoOperations() {
  const root=document.querySelector('#cryptoOperations');if(!root)return
  try{
    const [balanceData,modeData]=await Promise.all([api('/api/admin/crypto/sweep/balances'),api('/api/admin/crypto/payment-mode')])
    const balances=balanceData.balances||[],fixed=modeData.fixedAddresses||{}
    const fixedPayload={tron:fixed.fixed_tron_address||'',eth:fixed.fixed_erc20_address||'',bsc:fixed.fixed_bep20_address||'',sol:fixed.fixed_sol_address||''}
    root.innerHTML=`<div class="crypto-mode-editor"><label class="field"><span>支付地址模式</span><select class="select" id="cryptoPaymentMode"><option value="fixed" ${modeData.mode==='fixed'?'selected':''}>固定共享地址</option><option value="dynamic" ${modeData.mode==='dynamic'?'selected':''}>动态派生地址</option></select></label><div class="crypto-main-address"><span>主归集地址</span><strong>${escapeHtml(balanceData.mainAddress||'未配置')}</strong></div><button class="secondary-button" id="saveCryptoMode" type="button">保存模式</button></div><div class="crypto-address-list">${balances.map(item=>`<article class="crypto-address-row" data-crypto-index="${Number(item.index)}"><div><strong>派生地址 #${Number(item.index)}</strong><small>${escapeHtml(item.address||'--')}</small></div><div><span>USDT</span><strong>${Number(item.usdtBalance??item.usdt??0).toFixed(2)}</strong></div><div><span>TRX</span><strong>${Number(item.trxBalance??item.trx??0).toFixed(4)}</strong></div><button class="secondary-button" data-sweep-address type="button" ${item.canSweep?'':'disabled'}>归集此地址</button></article>`).join('')||'<div class="empty-state compact-empty">没有动态派生地址</div>'}</div><div class="crypto-operation-footer"><span>固定地址：TRON ${escapeHtml(fixedPayload.tron||'未配置')} · ETH ${escapeHtml(fixedPayload.eth||'未配置')}</span><button class="danger-button primary-button" id="sweepAllAddresses" type="button" ${balances.some(item=>item.canSweep)?'':'disabled'}>一键归集可用余额</button></div>`
    document.querySelector('#saveCryptoMode').onclick=async event=>{event.currentTarget.disabled=true;try{await api('/api/admin/crypto/payment-mode',{method:'POST',body:JSON.stringify({mode:document.querySelector('#cryptoPaymentMode').value,fixed_addresses:fixedPayload})});toast('支付地址模式已保存','success')}catch(error){handleError(error)}finally{event.currentTarget.disabled=false}}
    root.querySelectorAll('[data-sweep-address]').forEach(button=>button.onclick=async()=>{const row=button.closest('[data-crypto-index]');if(!await confirmAction('确认归集这个地址？',`将派生地址 #${row.dataset.cryptoIndex} 的可用余额归集到主地址。该操作会产生链上交易与网络费用。`,'确认归集',true))return;button.disabled=true;try{await api(`/api/admin/crypto/sweep/${row.dataset.cryptoIndex}`,{method:'POST'});toast('链上归集已提交','success');await loadCryptoOperations()}catch(error){handleError(error);button.disabled=false}})
    document.querySelector('#sweepAllAddresses').onclick=async event=>{if(!await confirmAction('确认一键归集？','系统会依次向所有可归集地址发起真实链上交易，并产生网络费用。','确认一键归集',true))return;event.currentTarget.disabled=true;try{const result=await api('/api/admin/crypto/sweep',{method:'POST'});toast(`归集完成：成功 ${Number(result.success||result.succeeded||0)} 个，失败 ${Number(result.failed||0)} 个`,'success');await loadCryptoOperations()}catch(error){handleError(error);event.currentTarget.disabled=false}}
  }catch(error){root.innerHTML=`<div class="empty-inline error-helper">${escapeHtml(error.message)}</div>`}
}
function bindSystemCategoryTools(category) {
  if(category==='smtp')document.querySelector('#smtpTestSend')?.addEventListener('click',async event=>{const target=document.querySelector('#smtpTestTarget').value.trim();if(!target)return handleError(new Error('请输入测试收件邮箱'));event.currentTarget.disabled=true;try{await api('/api/system-config/smtp/test',{method:'POST',body:JSON.stringify({to:target})});toast('测试邮件已发送','success')}catch(error){handleError(error)}finally{event.currentTarget.disabled=false}})
  if(category==='sms')document.querySelector('#smsTestSend')?.addEventListener('click',async event=>{const target=document.querySelector('#smsTestTarget').value.trim(),template=document.querySelector('#smsTestTemplate').value;if(!target)return handleError(new Error('请输入测试手机号'));if(!await confirmAction('发送测试短信？',`系统将立即向 ${target} 发送所选模板，可能产生短信费用。`,'确认发送'))return;event.currentTarget.disabled=true;try{await api('/api/system-config/sms/test',{method:'POST',body:JSON.stringify({to:target,template:template==='verification'?undefined:template})});toast('测试短信已发送','success')}catch(error){handleError(error)}finally{event.currentTarget.disabled=false}})
  if(category==='crypto_wallet')loadCryptoOperations()
}
function renderSystemConfigCategory() {
  const root=document.querySelector('#systemConfigEditor')
  if(!root||!state.systemConfig)return
  const category=state.systemConfigCategory
  const items=state.systemConfig[category]||[]
  root.innerHTML=`<header class="section-head"><div><h2>${escapeHtml(systemCategoryLabels[category]||category)}</h2><p>敏感内容不会回显；留空即可保留已保存的密钥或密码。</p></div></header><form class="config-editor-form" id="systemConfigForm">${items.map((item,index)=>`<label class="config-editor-row"><span><strong>${escapeHtml(item.label||item.key)}</strong><small>${escapeHtml(item.key)}</small></span>${systemConfigInput(item)}<input type="hidden" data-config-label="${escapeHtml(item.key)}" value="${escapeHtml(item.label||'')}"><input type="hidden" data-config-order="${escapeHtml(item.key)}" value="${Number(item.sort_order??index)}"></label>`).join('')||'<div class="empty-state">该分类暂无配置项</div>'}<div class="form-actions"><button class="primary-button" type="submit" ${items.length?'':'disabled'}>保存当前分类</button></div></form>${systemCategoryTools(category)}`
  document.querySelector('#systemConfigForm').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true
    try{
      const controls=[...root.querySelectorAll('[data-config-key]')]
      const payload=controls.map((control,index)=>{const key=control.dataset.configKey;let value=control.value;if(control.dataset.redacted==='true'&&!value)value='***REDACTED***';if(value&&(['items'].includes(key)||value.trim().startsWith('[')||value.trim().startsWith('{'))){try{JSON.parse(value)}catch{throw new Error(`${control.closest('label').querySelector('strong').textContent} 的 JSON 格式不正确`)}}return{key,value,label:root.querySelector(`[data-config-label="${CSS.escape(key)}"]`)?.value||'',sort_order:Number(root.querySelector(`[data-config-order="${CSS.escape(key)}"]`)?.value||index)}})
      await api(`/api/system-config/${encodeURIComponent(category)}`,{method:'PUT',body:JSON.stringify({items:payload})})
      toast(`${systemCategoryLabels[category]||'系统'}配置已保存`,'success');await loadSystemConfig()
    }catch(error){handleError(error)}finally{button.disabled=false}
  }
  bindSystemCategoryTools(category)
}
async function loadSystemConfig() {
  const data=await api('/api/system-config')
  state.systemConfig=data.config||{}
  const available=Object.keys(state.systemConfig).filter(key=>key!=='changelog')
  if(!available.includes(state.systemConfigCategory))state.systemConfigCategory=available[0]||''
  const nav=document.querySelector('#systemConfigCategories')
  if(nav){nav.innerHTML=available.map(key=>`<button class="config-nav-item ${key===state.systemConfigCategory?'is-active':''}" data-system-category="${escapeHtml(key)}" type="button"><span>${escapeHtml(systemCategoryLabels[key]||key)}</span><small>${state.systemConfig[key].length}</small></button>`).join('');nav.querySelectorAll('[data-system-category]').forEach(button=>button.onclick=()=>{state.systemConfigCategory=button.dataset.systemCategory;nav.querySelectorAll('[data-system-category]').forEach(item=>item.classList.toggle('is-active',item===button));renderSystemConfigCategory()})}
  renderSystemConfigCategory()
}
function renderContentSystem(){
  const o=state.contentOverview
  document.querySelector('#contentSystemBody').innerHTML=`<section class="system-workbench"><article class="panel release-panel"><header class="section-head"><div><h2>发布说明</h2><p>主站和 AI 实验室共用当前版本说明。</p></div></header><form class="panel-body release-form" id="releaseForm"><div class="field"><label for="releaseVersion">版本号</label><input class="input" id="releaseVersion" required maxlength="32" value="${escapeHtml(o.release.version)}"></div><div class="field"><label for="releaseContent">更新内容</label><textarea class="input release-textarea" id="releaseContent" required>${escapeHtml(o.release.content)}</textarea></div><button class="primary-button" type="submit">保存发布说明</button></form></article><section class="settings-workbench"><aside class="panel config-nav" id="systemConfigCategories"><div class="empty-inline">正在读取配置分类…</div></aside><article class="panel" id="systemConfigEditor"><div class="empty-state">正在读取系统配置…</div></article></section></section>`
  document.querySelector('#releaseForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await api('/api/admin/release-notes',{method:'POST',body:JSON.stringify({version:document.querySelector('#releaseVersion').value.trim(),content:document.querySelector('#releaseContent').value.trim()})});toast('发布说明已保存','success');await loadContentOverview()}catch(error){handleError(error)}finally{button.disabled=false}}
  loadSystemConfig().catch(handleError)
}
async function loadContentOverview(){const data=await api('/api/admin/content-system/overview');state.contentOverview=data.overview;if(state.contentTab==='system')renderContentSystem()}
async function renderContentTab(){if(state.contentTab==='assets')await loadCourseAssets();else if(state.contentTab==='feedback')await renderContentFeedback();else if(state.contentTab==='system'){if(!state.contentOverview)await loadContentOverview();else renderContentSystem()}else await renderContentCourses()}
async function renderContentSystemPage(){const main=document.querySelector('#adminMain');main.innerHTML=`<header class="page-head"><div><span class="eyebrow">课程、反馈与版本发布</span><h1>内容与系统</h1><p>日常内容运营与低频系统维护分开处理，降低配置干扰。</p></div></header>${contentTabs()}<div id="contentSystemBody"><div class="panel"><div class="empty-state">正在读取内容数据…</div></div></div>`;document.querySelectorAll('[data-content-tab]').forEach(button=>button.onclick=async()=>{state.contentTab=button.dataset.contentTab;document.querySelectorAll('[data-content-tab]').forEach(item=>item.classList.toggle('is-active',item===button));await renderContentTab()});await Promise.all([loadContentOverview(),renderContentTab()])}

async function setView(view) {
  state.view = view
  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.toggle('is-active', item.dataset.view === view))
  document.querySelector('#currentViewName').textContent = viewLabels[view] || '管理工作台'
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
document.querySelectorAll('#contentModal > [data-close-content-modal]').forEach(item => item.addEventListener('click', closeCourseEditor))
document.querySelectorAll('#entityModal > [data-close-entity-modal], #entityModal .modal-header [data-close-entity-modal]').forEach(item => item.addEventListener('click', closeEntityModal))
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  if (!document.querySelector('#entityModal').hidden) closeEntityModal()
  else if (!document.querySelector('#contentModal').hidden) closeCourseEditor()
  else if (!document.querySelector('#userModal').hidden) closeUserModal()
})
document.querySelector('#mobileMenuButton').addEventListener('click', () => { const open = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', open); document.querySelector('#drawerScrim').hidden = !open; document.querySelector('#mobileMenuButton').setAttribute('aria-expanded',String(open)) })
document.querySelector('#drawerScrim').addEventListener('click', () => { document.body.classList.remove('nav-open'); document.querySelector('#drawerScrim').hidden = true })

const quickNavInput = document.querySelector('#adminQuickNavSearch')
function filterAdminNavigation() {
  const keyword = quickNavInput.value.trim().toLowerCase()
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.hidden = Boolean(keyword) && !item.textContent.trim().toLowerCase().includes(keyword)
  })
}
quickNavInput.addEventListener('input', filterAdminNavigation)
quickNavInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    quickNavInput.value = ''
    filterAdminNavigation()
    quickNavInput.blur()
  }
  if (event.key === 'Enter') {
    const target = [...document.querySelectorAll('.nav-item[data-view]')].find(item => !item.hidden)
    if (target) {
      quickNavInput.value = ''
      filterAdminNavigation()
      setView(target.dataset.view)
    }
  }
})
document.addEventListener('keydown', event => {
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
    event.preventDefault()
    quickNavInput.focus()
  }
})

async function bootstrap() {
  try {
    await loadProfile()
    const requested = new URLSearchParams(location.search).get('view')
    await setView(['users','commercial','ai-operations','risk-audit','content-system'].includes(requested) ? requested : 'overview')
  } catch (error) { handleError(error) }
}
bootstrap()
