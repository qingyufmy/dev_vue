const $ = id => document.getElementById(id)
const accountParams = new URLSearchParams(location.search)
const embedMode = ['ai','main','admin'].includes(accountParams.get('embed')) ? accountParams.get('embed') : ''
const embedded = Boolean(embedMode)
const state = { user:null, plans:null, orders:null, referral:null, notifications:null, notificationUnread:0, period:'month', tab:'overview', paymentTimer:null }
const TAB_META = {
  overview:['账户概览','查看会员状态和常用账户信息。'],
  profile:['个人资料','管理头像、昵称和账户基础信息。'],
  security:['账户安全','修改登录密码并检查绑定信息。'],
  notifications:['消息通知','查看账户、社区与系统通知。'],
  subscription:['订阅与续费','查看当前权益，续费或升级会员。'],
  orders:['支付订单','查看历史订单与支付状态。'],
  referral:['邀请奖励','查看邀请码、邀请人数和可用奖励。'],
}

if (embedded) document.body.classList.add('account-embedded')
if (embedMode === 'admin') document.body.classList.add('account-admin-embedded')
if (embedMode === 'main') {
  document.body.classList.add('account-main-embedded')
  document.body.classList.toggle('account-main-dark', accountParams.get('theme') === 'dark')
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]) }
function formatDate(value) { if (!value) return '长期有效'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN',{ hour12:false }) }
function money(value) { return `$${Number(value || 0).toFixed(2)}` }
function planLabel(value) { return ({ free:'体验版',plus:'Plus 专业版',pro:'Pro 交易版' })[value] || value || '体验版' }
function effectivePlan() { return state.user?.effectivePlan || (state.user?.membershipExpired ? 'free' : state.user?.plan) || 'free' }

async function api(path, options = {}) {
  const response = await fetch(path,{ ...options, headers:AuthSession.headers({ 'Content-Type':'application/json', ...(options.headers || {}) }), body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body })
  if (response.status === 401 || response.status === 403 && !AuthSession.token()) {
    AuthSession.clear()
    const next = encodeURIComponent(`${location.pathname}${location.search}`)
    if (embedded) notifyParent('account-session-logout')
    location.replace(embedMode === 'ai' ? `/ai/auth/?mode=login&next=${next}` : `/auth/login?next=${next}`)
    throw new Error('登录状态已失效')
  }
  const data = await response.json().catch(() => ({ ok:false,error:'服务器返回了无法识别的数据' }))
  if (!response.ok || data.ok === false) throw new Error(data.error || '请求失败')
  return data
}

function toast(message,type='') {
  const node = document.createElement('div')
  node.className = `toast ${type}`
  node.textContent = message
  $('toastHost').appendChild(node)
  setTimeout(() => node.remove(),3600)
}

function notifyParent(type,payload={}) {
  if (window.parent !== window) window.parent.postMessage({ type,...payload },location.origin)
}

function setSync(text='同步完成',ready=true) {
  $('accountSyncStatus').textContent = text
  $('accountSyncStatus').classList.toggle('ready',ready)
}

function renderIdentity() {
  const user = state.user
  const avatar = user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="">` : escapeHtml((user.name || 'U').slice(0,1).toUpperCase())
  $('accountIdentity').innerHTML = `<span class="user-avatar">${avatar}</span><div><strong>${escapeHtml(user.name || '未设置昵称')}</strong><small>${escapeHtml(planLabel(user.plan))}${user.membershipExpired ? ' · 已过期' : ''}</small></div>`
}

function switchTab(tab,{ push=true }={}) {
  if (!TAB_META[tab]) tab = 'overview'
  state.tab = tab
  const [title,description] = TAB_META[tab]
  $('accountPageTitle').textContent = title
  $('accountPageDescription').textContent = description
  document.querySelectorAll('#accountNav [data-tab]').forEach(button => {
    if (button.dataset.tab === tab) button.setAttribute('aria-current','page')
    else button.removeAttribute('aria-current')
  })
  if (push) {
    const url = new URL(location.href)
    url.searchParams.set('tab',tab)
    history.replaceState({},'',url)
  }
  renderTab()
}

function overviewTemplate() {
  const user = state.user
  const activePlan = effectivePlan()
  const expired = Boolean(user.membershipExpired)
  const expiry = user.planExpiresAt ? formatDate(user.planExpiresAt) : activePlan === 'free' ? '未订阅' : '长期有效'
  return `<div class="overview-hero">
    <article class="panel membership-card"><header><span class="plan-badge">${escapeHtml(expired ? `${planLabel(user.plan)} · 已过期` : planLabel(activePlan))}</span><span class="status-badge ${expired ? 'failed' : 'paid'}">${expired ? '需要续费' : activePlan === 'free' ? '体验账户' : '权益生效中'}</span></header><h2>${escapeHtml(user.name || '你好')}</h2><p>${expired ? '会员已到期，续费后主站和 AI 实验室会同时恢复。' : '你的账户、会员与两个前端保持实时一致。'}</p><div class="membership-facts"><span>账户 UID<strong>${escapeHtml(user.uid || '--')}</strong></span><span>会员到期<strong>${escapeHtml(expiry)}</strong></span><span>注册时间<strong>${escapeHtml(formatDate(user.accountCreatedAt))}</strong></span></div></article>
    <article class="panel quick-actions"><h2>常用操作</h2><p>无需离开账户中心即可完成常见设置。</p><button class="quick-action" data-open-tab="subscription"><span>续费或升级</span><small>查看套餐 →</small></button><button class="quick-action" data-open-tab="profile"><span>编辑个人资料</span><small>头像、昵称 →</small></button><button class="quick-action" data-open-tab="security"><span>账户安全</span><small>密码与绑定 →</small></button></article>
  </div><div class="metric-grid"><article class="panel metric"><span>当前有效权益</span><strong>${escapeHtml(planLabel(activePlan))}</strong></article><article class="panel metric"><span>登录账号</span><strong>${escapeHtml(user.email || user.phone || '--')}</strong></article><article class="panel metric"><span>账户来源</span><strong>${user.planSource === 'gift' ? '平台体验' : user.planSource === 'paid' ? '付费订阅' : '注册账户'}</strong></article></div>`
}

function profileTemplate() {
  const user = state.user
  const avatar = user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="当前头像">` : escapeHtml((user.name || 'U').slice(0,1).toUpperCase())
  return `<div class="section-stack"><article class="panel"><div class="section-heading"><div><h2>公开资料</h2><p>昵称会显示在主站社区和账户区域。</p></div></div><div class="profile-avatar-editor"><span class="user-avatar">${avatar}</span><div><label class="button secondary" for="avatarInput">更换头像</label><input id="avatarInput" type="file" accept="image/jpeg,image/png,image/webp" hidden><p class="field-help">支持 JPG、PNG、WebP，保存前自动压缩。</p></div></div><form id="profileForm"><div class="form-grid"><label class="form-field full"><span>昵称</span><input id="profileName" maxlength="32" value="${escapeHtml(user.name || '')}" autocomplete="nickname"><small class="field-help">2–32 个字符</small></label></div><div class="form-actions"><button class="button primary" type="submit">保存个人资料</button></div></form></article><article class="panel info-list"><div class="info-row"><span>UID</span><strong>${escapeHtml(user.uid || '--')}</strong></div><div class="info-row"><span>注册时间</span><strong>${escapeHtml(formatDate(user.accountCreatedAt))}</strong></div><div class="info-row"><span>Telegram</span><strong>${escapeHtml(user.telegramBinding?.username ? `@${user.telegramBinding.username}` : '未绑定')}</strong></div></article></div>`
}

function securityTemplate() {
  const user = state.user
  return `<div class="section-stack"><article class="panel info-list"><div class="section-heading"><div><h2>登录方式</h2><p>敏感信息由服务器验证，前端不能直接修改。</p></div></div><div class="info-row"><span>邮箱</span><strong>${escapeHtml(user.email || '未绑定')}</strong></div><div class="info-row"><span>手机号</span><strong>${escapeHtml(user.phone || '未绑定')}</strong></div><div class="info-row"><span>主要登录方式</span><strong>${user.authMethod === 'phone' ? '手机号' : '邮箱'}</strong></div></article><article class="panel"><div class="section-heading"><div><h2>修改密码</h2><p>修改后主站和 AI 实验室都需要使用新密码。</p></div></div><form id="passwordForm"><div class="form-grid"><label class="form-field full"><span>当前密码</span><input id="oldPassword" type="password" autocomplete="current-password" required></label><label class="form-field"><span>新密码</span><input id="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="32" required><small class="field-help">8–32 位，包含字母和数字</small></label><label class="form-field"><span>确认新密码</span><input id="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="32" required></label></div><div class="form-actions"><button class="button primary" type="submit">更新密码</button></div></form></article><article class="panel panel-body"><button id="securityLogoutBtn" class="button danger" type="button">退出主站与 AI 实验室</button><p class="field-help">退出会清除当前浏览器中两个前端的登录状态。</p></article></div>`
}

function planPrice(plan,period) { const row = state.plans?.[plan]?.[period]; return typeof row === 'object' ? Number(row.current || 0) : Number(row || 0) }
function subscriptionTemplate() {
  const current = effectivePlan()
  const suffix = state.period === 'year' ? '/年' : '/月'
  const price = plan => money(planPrice(plan,state.period))
  return `<div class="section-stack"><article class="panel"><div class="section-heading"><div><h2>选择会员</h2><p>续费从当前到期时间顺延；付费成功后两个前端同时生效。</p></div><div class="plan-switch"><button data-period="month" class="${state.period === 'month' ? 'active' : ''}">月付</button><button data-period="year" class="${state.period === 'year' ? 'active' : ''}">年付</button></div></div><div class="plan-grid"><article class="plan-card"><header><div><h3>Plus 专业版</h3><p>课程进阶与 AI 观摩</p></div>${current === 'plus' ? '<span class="status-badge paid">当前权益</span>' : ''}</header><div class="plan-price">${price('plus')} <small>${suffix}</small></div><ul class="plan-features"><li>主站进阶课程与学习工具</li><li>AI 实验室观摩模式</li><li>会员到期通知</li></ul><button class="button secondary" data-buy-plan="plus">${current === 'plus' ? '续费 Plus' : '购买 Plus'}</button></article><article class="plan-card recommended"><header><div><h3>Pro 交易版</h3><p>完整 AI 交易工作台</p></div>${current === 'pro' ? '<span class="status-badge paid">当前权益</span>' : '<span class="plan-badge">推荐</span>'}</header><div class="plan-price">${price('pro')} <small>${suffix}</small></div><ul class="plan-features"><li>包含 Plus 全部权益</li><li>连接 MT5 桥接软件</li><li>自动分析、策略与风控</li></ul><button class="button primary" data-buy-plan="pro">${current === 'pro' ? '续费 Pro' : '购买 Pro'}</button></article></div></article><article class="panel info-list"><div class="info-row"><span>当前购买方案</span><strong>${escapeHtml(planLabel(state.user.plan))}${state.user.membershipExpired ? '（已过期）' : ''}</strong></div><div class="info-row"><span>当前有效权限</span><strong>${escapeHtml(planLabel(current))}</strong></div><div class="info-row"><span>到期时间</span><strong>${escapeHtml(formatDate(state.user.planExpiresAt))}</strong></div></article></div>`
}

function ordersTemplate() {
  if (!state.orders) return '<div class="page-loading"><span></span><strong>正在读取支付订单</strong></div>'
  if (!state.orders.length) return '<div class="empty-state"><strong>还没有支付订单</strong><button class="button primary" data-open-tab="subscription">查看会员套餐</button></div>'
  return `<article class="panel"><div class="section-heading"><div><h2>订单记录</h2><p>按创建时间倒序展示，支付状态以服务器为准。</p></div></div><div class="order-list">${state.orders.map(order => `<div class="order-row"><div><strong>${escapeHtml(order.planLabel)} · ${escapeHtml(order.periodLabel)}</strong><small>${escapeHtml(order.orderId)} · ${escapeHtml(formatDate(order.createdAt))}</small></div><span class="status-badge ${order.status === 'paid' ? 'paid' : ['expired','cancelled','failed'].includes(order.status) ? 'failed' : ''}">${escapeHtml(order.statusLabel)}</span><strong class="order-amount">${money(order.amountConfirmed)}</strong></div>`).join('')}</div></article>`
}

function notificationsTemplate() {
  if (!state.notifications) return '<div class="page-loading"><span></span><strong>正在读取消息通知</strong></div>'
  if (!state.notifications.length) return '<div class="empty-state"><strong>暂时没有消息</strong><span>账户和社区的重要动态会显示在这里。</span></div>'
  return `<article class="panel"><div class="section-heading"><div><h2>消息通知</h2><p>未读 ${Number(state.notificationUnread || 0)} 条</p></div>${state.notificationUnread ? '<button id="markNotificationsRead" class="button secondary">全部标为已读</button>' : ''}</div><div class="order-list">${state.notifications.map(item => `<div class="order-row"><div><strong>${escapeHtml(item.title || '系统通知')}</strong><small>${escapeHtml(item.message || '')}</small><small>${escapeHtml(formatDate(item.createdAt))}</small></div><span class="status-badge ${item.isRead ? '' : 'paid'}">${item.isRead ? '已读' : '未读'}</span></div>`).join('')}</div></article>`
}

function referralTemplate() {
  if (!state.referral) return '<div class="page-loading"><span></span><strong>正在读取邀请信息</strong></div>'
  const stats = state.referral.stats || {}
  return `<div class="section-stack"><article class="panel"><div class="section-heading"><div><h2>邀请链接</h2><p>好友通过该链接注册后，归因和奖励由服务器记录。</p></div></div><div class="referral-code"><input id="referralLink" value="${escapeHtml(state.referral.referral_link || '')}" readonly><button id="copyReferralBtn" class="button secondary">复制链接</button></div></article><div class="metric-grid"><article class="panel metric"><span>已邀请</span><strong>${Number(stats.invited_count || 0)} 人</strong></article><article class="panel metric"><span>已付费</span><strong>${Number(stats.paid_invited_count || 0)} 人</strong></article><article class="panel metric"><span>可用奖励</span><strong>${money(Number(stats.available_credit_amount || 0))}</strong></article></div></div>`
}

function renderTab() {
  const templates = { overview:overviewTemplate,profile:profileTemplate,security:securityTemplate,notifications:notificationsTemplate,subscription:subscriptionTemplate,orders:ordersTemplate,referral:referralTemplate }
  $('accountContent').innerHTML = templates[state.tab]()
  bindTabActions()
  if (state.tab === 'orders' && !state.orders) void loadOrders()
  if (state.tab === 'notifications' && !state.notifications) void loadNotifications()
  if (state.tab === 'referral' && !state.referral) void loadReferral()
}

function bindTabActions() {
  document.querySelectorAll('[data-open-tab]').forEach(button => button.addEventListener('click',() => switchTab(button.dataset.openTab)))
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click',() => { state.period = button.dataset.period; renderTab() }))
  document.querySelectorAll('[data-buy-plan]').forEach(button => button.addEventListener('click',() => void createPayment(button.dataset.buyPlan,button)))
  $('profileForm')?.addEventListener('submit',event => { event.preventDefault(); void saveProfile(event.currentTarget) })
  $('avatarInput')?.addEventListener('change',event => void saveAvatar(event.target.files?.[0]))
  $('passwordForm')?.addEventListener('submit',event => { event.preventDefault(); void changePassword(event.currentTarget) })
  $('markNotificationsRead')?.addEventListener('click',() => void markNotificationsRead())
  $('securityLogoutBtn')?.addEventListener('click',logoutEverywhere)
  $('copyReferralBtn')?.addEventListener('click',async () => { await navigator.clipboard.writeText($('referralLink').value); toast('邀请链接已复制') })
}

async function saveProfile(form) {
  const button = form.querySelector('[type="submit"]')
  const name = $('profileName').value.trim()
  if (name.length < 2) return toast('昵称至少需要 2 个字符','error')
  button.disabled = true
  try {
    const result = await api('/api/profile',{ method:'PUT',body:{ name } })
    state.user = { ...state.user,...result.user }
    localStorage.setItem('ws_user',JSON.stringify(state.user))
    renderIdentity(); renderTab(); notifyParent('account-profile-updated',{ user:state.user }); toast('个人资料已保存')
  } catch (error) { toast(error.message,'error') } finally { button.disabled = false }
}

async function compressImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('请选择图片文件')
  if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8MB')
  const image = await new Promise((resolve,reject) => { const node = new Image(); node.onload=()=>resolve(node); node.onerror=reject; node.src=URL.createObjectURL(file) })
  const size = 240, canvas = document.createElement('canvas'); canvas.width=size; canvas.height=size
  const context = canvas.getContext('2d'); const scale=Math.max(size/image.width,size/image.height); const w=image.width*scale,h=image.height*scale
  context.drawImage(image,(size-w)/2,(size-h)/2,w,h)
  return canvas.toDataURL('image/jpeg',.84)
}

async function saveAvatar(file) {
  try {
    const avatar = await compressImage(file)
    const result = await api('/api/profile',{ method:'PUT',body:{ avatar } })
    state.user = { ...state.user,...result.user }; localStorage.setItem('ws_user',JSON.stringify(state.user))
    renderIdentity(); renderTab(); notifyParent('account-profile-updated',{ user:state.user }); toast('头像已更新')
  } catch (error) { toast(error.message || '头像更新失败','error') }
}

async function changePassword(form) {
  const oldPassword=$('oldPassword').value,newPassword=$('newPassword').value,confirm=$('confirmPassword').value
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) return toast('新密码需要至少 8 位，并包含字母和数字','error')
  if (newPassword !== confirm) return toast('两次输入的新密码不一致','error')
  const button=form.querySelector('[type="submit"]'); button.disabled=true
  try { await api('/api/change-password',{ method:'POST',body:{ oldPassword,newPassword } }); form.reset(); toast('密码已更新') }
  catch(error){ toast(error.message,'error') } finally { button.disabled=false }
}

async function loadOrders() {
  try { const result=await api('/api/orders'); state.orders=result.orders || []; if(state.tab==='orders') renderTab() }
  catch(error){ toast(error.message,'error'); state.orders=[]; if(state.tab==='orders') renderTab() }
}
async function loadNotifications() {
  try { const result=await api('/api/notifications?limit=50'); state.notifications=result.notifications || []; state.notificationUnread=Number(result.unreadCount || 0); if(state.tab==='notifications') renderTab() }
  catch(error){ toast(error.message,'error'); state.notifications=[]; if(state.tab==='notifications') renderTab() }
}
async function markNotificationsRead() {
  try { await api('/api/notifications',{ method:'PATCH',body:{ markAll:true } }); state.notifications=(state.notifications || []).map(item=>({ ...item,isRead:true })); state.notificationUnread=0; notifyParent('account-notifications-updated',{ unreadCount:0 }); renderTab(); toast('全部消息已标为已读') }
  catch(error){ toast(error.message,'error') }
}
async function loadReferral() {
  try { state.referral=await api('/api/referrals/me'); if(state.tab==='referral') renderTab() }
  catch(error){ toast(error.message,'error'); state.referral={ stats:{} }; if(state.tab==='referral') renderTab() }
}

async function createPayment(plan,button) {
  button.disabled=true
  try {
    const result=await api('/api/payment',{ method:'POST',body:{ plan,period:state.period,crypto_chain:'TRON',use_referral_credit:true } })
    if (result.paid_with_credit) { toast('订阅已使用奖励余额支付完成'); await refreshProfile(); return }
    openPayment(result)
  } catch(error){ toast(error.message,'error') } finally { button.disabled=false }
}

function openPayment(order) {
  clearInterval(state.paymentTimer)
  $('paymentDialogContent').innerHTML=`<section class="payment-sheet"><header><div><h2>${escapeHtml(order.label || 'USDT 支付')}</h2><p>请使用 TRC-20 网络转入精确金额，系统会自动确认。</p></div><button class="icon-button" data-close-payment aria-label="关闭">×</button></header><div class="payment-qr">${order.qr_code ? `<img src="${escapeHtml(order.qr_code)}" alt="付款二维码">` : '<strong>二维码生成失败，请复制地址付款</strong>'}</div><div class="payment-detail"><div><span>应付金额</span><strong>${escapeHtml(order.crypto_amount)} USDT</strong></div><div><span>确认要求</span><strong>${Number(order.required_confirmations || 1)} 次链上确认</strong></div><div class="payment-address"><span>TRC-20 收款地址</span><strong>${escapeHtml(order.crypto_address)}</strong></div><div><span>订单号</span><strong>${escapeHtml(order.orderNo)}</strong></div><div><span>支付状态</span><strong id="paymentStatus">等待付款</strong></div></div><div class="payment-actions"><button class="button secondary" data-copy-address="${escapeHtml(order.crypto_address)}">复制地址</button><button class="button quiet" data-close-payment>稍后支付</button></div></section>`
  $('paymentDialog').showModal()
  document.querySelectorAll('[data-close-payment]').forEach(button=>button.addEventListener('click',()=>$('paymentDialog').close()))
  document.querySelector('[data-copy-address]')?.addEventListener('click',async event=>{ await navigator.clipboard.writeText(event.currentTarget.dataset.copyAddress); toast('收款地址已复制') })
  state.paymentTimer=setInterval(()=>void pollPayment(order.orderId),5000)
}

async function pollPayment(orderId) {
  try {
    const result=await api(`/api/payment/status/${encodeURIComponent(orderId)}`)
    const host=$('paymentStatus'); if(host) host.textContent=result.statusLabel || result.status
    if(result.status==='paid') { clearInterval(state.paymentTimer); toast('支付已确认，会员权益已经更新'); setTimeout(()=>$('paymentDialog').close(),900); state.orders=null; await refreshProfile() }
    if(['expired','cancelled','failed'].includes(result.status)) clearInterval(state.paymentTimer)
  } catch {}
}

async function logoutEverywhere() {
  try { await api('/api/auth/logout-all',{ method:'POST' }) } catch {}
  AuthSession.clear(); notifyParent('account-session-logout'); location.replace(embedMode === 'ai' ? '/ai/auth/?mode=login' : embedded ? '/auth/login?mode=login' : '/')
}

async function refreshProfile() {
  const result=await api('/api/profile'); state.user=result.user; localStorage.setItem('ws_user',JSON.stringify(state.user)); renderIdentity(); renderTab(); notifyParent('account-profile-updated',{ user:state.user })
}

async function bootstrap() {
  if (!AuthSession.token()) {
    const next=encodeURIComponent(`${location.pathname}${location.search}`)
    if (embedded) notifyParent('account-session-logout')
    location.replace(embedMode === 'ai' ? `/ai/auth/?mode=login&next=${next}` : `/auth/login?next=${next}`)
    return
  }
  try {
    const [profileResult,plansResult]=await Promise.all([api('/api/profile'),api('/api/plans')])
    state.user=profileResult.user; state.plans=plansResult.plans || {}; localStorage.setItem('ws_user',JSON.stringify(state.user))
    renderIdentity(); setSync(); switchTab(new URLSearchParams(location.search).get('tab') || 'overview',{ push:false })
  } catch(error) { $('accountContent').innerHTML=`<div class="empty-state"><strong>账户信息加载失败</strong><span>${escapeHtml(error.message)}</span><button class="button secondary" onclick="location.reload()">重新加载</button></div>`; setSync('同步失败',false) }
}

$('accountNav').addEventListener('click',event=>{ const button=event.target.closest('[data-tab]'); if(button) switchTab(button.dataset.tab) })
$('accountLogoutBtn').addEventListener('click',logoutEverywhere)
$('accountCloseBtn').addEventListener('click',()=>embedded ? notifyParent('account-center-close') : history.length > 1 ? history.back() : location.assign('/'))
$('paymentDialog').addEventListener('close',()=>clearInterval(state.paymentTimer))
window.addEventListener('keydown',event=>{ if(event.key==='Escape' && embedded){ event.preventDefault(); notifyParent('account-center-close') } })
window.addEventListener('storage',event=>{ if(event.key===AuthSession.eventKey && !AuthSession.token()) location.replace(embedMode === 'ai' ? '/ai/auth/?mode=login' : embedded ? '/auth/login?mode=login' : '/') })
window.addEventListener('message',event=>{
  if(event.origin!==location.origin || event.source!==window.parent) return
  if(event.data?.type==='account-center-tab') switchTab(event.data.tab || 'overview')
  if(event.data?.type==='account-center-theme' && embedMode === 'main') document.body.classList.toggle('account-main-dark',event.data.theme === 'dark')
})

void bootstrap()
