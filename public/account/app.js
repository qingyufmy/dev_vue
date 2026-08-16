const $ = id => document.getElementById(id)
const accountParams = new URLSearchParams(location.search)
const embedMode = ['ai','main','admin'].includes(accountParams.get('embed')) ? accountParams.get('embed') : ''
const embedded = Boolean(embedMode)
const notificationQueryId = accountParams.get('notification') || accountParams.get('notice') || ''
const state = {
  user:null, plans:null, orders:null, referral:null, notifications:null,
  notificationUnread:0, notificationImportantUnacknowledgedCount:0,
  notificationLatestImportant:null, notificationFocusId:notificationQueryId,
  period:'month', tab:'overview', paymentTimer:null, securityCooldown:null,
  securityFlow:null, securityReturnFocus:null, notificationSummaryFlight:null,
  paymentCountdownTimer:null,
}
const TAB_META = {
  overview:['账户概览','查看会员状态和常用账户信息。'],
  profile:['个人资料','管理头像、昵称和账户基础信息。'],
  security:['账户安全','管理登录方式、找回方式和登录安全。'],
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
function maskEmail(value) {
  const [name,domain] = String(value || '').split('@')
  if (!name || !domain) return value || '未绑定'
  const visible = name.length > 2 ? name.slice(0,2) : name.slice(0,1)
  return `${visible}***@${domain}`
}
function maskPhone(value) {
  const phone = String(value || '')
  if (!phone) return '未绑定'
  if (phone.length <= 7) return `${phone.slice(0,2)}***${phone.slice(-2)}`
  return `${phone.slice(0,3)}****${phone.slice(-4)}`
}
function securityIcon(name) {
  const paths = {
    shield:'<path d="M12 3 5 6v5c0 4.8 2.9 8 7 10 4.1-2 7-5.2 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/>',
    mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone:'<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-6 0 3 3"/>',
    logout:'<path d="M10 17 15 12 10 7m5 5H3m12-9h5v18h-5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    warning:'<path d="M12 4 3 20h18L12 4Z"/><path d="M12 9v4m0 3h.01"/>',
    eye:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.shield}</svg>`
}

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

async function copyTextWithFallback(value) {
  const text = String(value ?? '')
  if (!text) throw new Error('copy_empty')

  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {}
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly','')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  let copied = false
  try { copied = typeof document.execCommand === 'function' && document.execCommand('copy') } catch {}
  textarea.remove()
  if (!copied) throw new Error('copy_failed')
}

function notifyParent(type,payload={}) {
  if (window.parent !== window) window.parent.postMessage({ type,...payload },location.origin)
}

function normalizeNotificationPriority(item={}) {
  const value = String(item.priority ?? item.level ?? '').trim().toLowerCase()
  return ['important','high','urgent'].includes(value) || item.requiresAck ? 'important' : 'normal'
}

function normalizeNotification(item={}) {
  return {
    id:item.id,
    type:item.type || 'system',
    title:item.title || '系统通知',
    message:item.message || '',
    link:item.link || '',
    priority:normalizeNotificationPriority(item),
    requiresAck:Boolean(item.requiresAck ?? item.requires_ack ?? normalizeNotificationPriority(item) === 'important'),
    isRead:Boolean(item.isRead ?? item.is_read),
    readAt:item.readAt ?? item.read_at ?? null,
    acknowledgedAt:item.acknowledgedAt ?? item.acknowledged_at ?? null,
    createdAt:item.createdAt ?? item.created_at ?? null,
  }
}

function normalizeLatestImportant(item) {
  if (!item || item.id == null) return null
  const normalized = normalizeNotification(item)
  return {
    id:normalized.id,
    title:normalized.title,
    priority:normalized.priority,
    requiresAck:normalized.requiresAck,
    // The summary endpoint may include a short display message for the local
    // AI banner. It is deliberately omitted from postMessage payloads below.
    ...(item.message ? { message:String(item.message) } : {}),
  }
}

function notificationSummaryFrom(result={}) {
  const summary = result.summary && typeof result.summary === 'object' ? result.summary : result
  const unreadValue = summary.unreadCount ?? summary.unread_count ?? result.unreadCount
  const importantValue = summary.importantUnacknowledgedCount ?? summary.important_unacknowledged_count
  const latestPresent = Object.prototype.hasOwnProperty.call(summary,'latestImportant') || Object.prototype.hasOwnProperty.call(summary,'latest_important')
  const latest = summary.latestImportant ?? summary.latest_important ?? null
  return {
    unreadCount:unreadValue == null ? null : Number(unreadValue),
    importantUnacknowledgedCount:importantValue == null ? null : Number(importantValue),
    latestImportant:latestPresent ? normalizeLatestImportant(latest) : undefined,
  }
}

function notificationSummaryPayload() {
  const latest = state.notificationLatestImportant
  return {
    unreadCount:Number(state.notificationUnread || 0),
    importantUnacknowledgedCount:Number(state.notificationImportantUnacknowledgedCount || 0),
    latestImportant:latest ? {
      id:latest.id,
      title:latest.title,
      priority:latest.priority,
      requiresAck:Boolean(latest.requiresAck),
    } : null,
  }
}

function syncNotificationSummary(summary, { notify=true }={}) {
  const next = summary || {}
  if (next.unreadCount != null && Number.isFinite(Number(next.unreadCount))) state.notificationUnread = Math.max(0,Number(next.unreadCount))
  if (next.importantUnacknowledgedCount != null && Number.isFinite(Number(next.importantUnacknowledgedCount))) state.notificationImportantUnacknowledgedCount = Math.max(0,Number(next.importantUnacknowledgedCount))
  if (next.latestImportant !== undefined) state.notificationLatestImportant = normalizeLatestImportant(next.latestImportant)
  if (notify) notifyParent('account-notifications-updated',notificationSummaryPayload())
}

function safeNotificationLink(value) {
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return ''
  let url
  try { url = new URL(raw,location.origin) } catch { return '' }
  if (url.origin !== location.origin) return ''
  let decodedPath
  try { decodedPath = decodeURIComponent(url.pathname || '/') } catch { return '' }
  if (decodedPath.startsWith('//') || decodedPath.includes('\\') || decodedPath.split('/').includes('..')) return ''
  let canonicalUrl
  try { canonicalUrl = new URL(decodedPath,location.origin) } catch { return '' }
  if (canonicalUrl.origin !== location.origin) return ''
  const pathname = canonicalUrl.pathname || '/'
  if (pathname.startsWith('/admin') || pathname.startsWith('/api') || pathname.startsWith('/download')) return ''
  if (pathname !== '/' && !pathname.startsWith('/account/') && !pathname.startsWith('/ai/')) return ''
  return `${pathname}${url.search}${url.hash}`
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
  const emailBound = Boolean(user.email)
  const phoneBound = Boolean(user.phone)
  const completed = 1 + Number(emailBound) + Number(phoneBound)
  const recommended = !emailBound ? 'email' : !phoneBound ? 'phone' : ''
  const summary = completed === 3 ? '账户保护完整' : `已完成 ${completed} 项保护`
  const summaryText = completed === 3 ? '登录与找回方式均已配置，请继续妥善保管密码。' : `建议${!emailBound ? '绑定邮箱' : '绑定手机号'}，避免忘记密码后无法找回账户。`
  const contactCard = (type,bound,value) => {
    const isEmail = type === 'email'
    const title = isEmail ? '邮箱' : '手机号'
    const masked = isEmail ? maskEmail(value) : maskPhone(value)
    const action = bound ? `更换${title}` : `绑定${title}`
    const helper = isEmail ? '用于登录、找回密码和接收安全通知' : '用于登录、找回密码和身份验证'
    const buttonClass = !bound && recommended === type ? 'primary' : 'secondary'
    return `<article class="security-contact-card">
      <div class="security-card-icon">${securityIcon(isEmail ? 'mail' : 'phone')}</div>
      <div class="security-card-copy"><div class="security-card-title"><h3>${title}</h3><span class="security-state ${bound ? 'success' : 'warning'}">${securityIcon(bound ? 'check' : 'warning')} ${bound ? '已绑定' : '未绑定'}</span></div><strong>${escapeHtml(masked)}</strong><p>${helper}</p></div>
      <button class="button ${buttonClass}" type="button" data-security-action="${type}">${action}</button>
    </article>`
  }
  return `<div class="section-stack security-page">
    <article class="panel security-overview">
      <div class="security-overview-icon">${securityIcon('shield')}</div>
      <div><span class="security-kicker">账户保护状态</span><h2>${summary}</h2><p>${summaryText}</p><div class="security-checks"><span class="${emailBound ? 'done' : ''}">${securityIcon(emailBound ? 'check' : 'warning')} 邮箱${emailBound ? '已绑定' : '未绑定'}</span><span class="${phoneBound ? 'done' : ''}">${securityIcon(phoneBound ? 'check' : 'warning')} 手机${phoneBound ? '已绑定' : '未绑定'}</span><span class="done">${securityIcon('check')} 密码已设置</span></div></div>
      ${recommended ? `<button class="button primary security-overview-action" type="button" data-security-action="${recommended}">立即${recommended === 'email' ? '绑定邮箱' : '绑定手机'}</button>` : ''}
    </article>
    <section aria-labelledby="securityContactTitle"><div class="security-section-heading"><div><h2 id="securityContactTitle">登录与找回方式</h2><p>敏感信息已脱敏显示，修改前需要完成身份验证。</p></div><span class="security-primary-method">主要登录：${user.authMethod === 'phone' ? '手机号' : '邮箱'}</span></div><div class="security-contact-grid">${contactCard('email',emailBound,user.email)}${contactCard('phone',phoneBound,user.phone)}</div></section>
    <section aria-labelledby="securityLoginTitle"><div class="security-section-heading"><div><h2 id="securityLoginTitle">登录安全</h2><p>密码修改和全端退出均会影响当前登录状态。</p></div></div><div class="security-action-list">
      <article class="security-action-row"><div class="security-action-icon">${securityIcon('key')}</div><div><h3>登录密码</h3><p>建议使用与其他网站不同的密码，至少包含字母和数字。</p></div><span class="security-state success">${securityIcon('check')} 已设置</span><button class="button secondary" type="button" data-security-action="password">修改密码</button></article>
      <article class="security-action-row danger-zone"><div class="security-action-icon danger">${securityIcon('logout')}</div><div><h3>退出所有登录</h3><p>退出主站、AI 实验室，并撤销量见智桥的服务器授权。</p></div><button class="button danger" type="button" data-security-action="logout">退出所有登录</button></article>
    </div></section>
  </div>`
}

function dialogHeader(title,description,icon='shield',eyebrow='账户安全') {
  return `<header class="dialog-header"><div class="dialog-title-group"><span class="dialog-title-icon">${securityIcon(icon)}</span><div><p class="dialog-eyebrow">${eyebrow}</p><h2 id="securityDialogTitle">${title}</h2><p>${description}</p></div></div><button class="dialog-close" type="button" data-close-security aria-label="关闭${title}">&times;</button></header>`
}

function clearSecurityCooldown() {
  clearInterval(state.securityCooldown)
  state.securityCooldown = null
}

function closeSecurityDialog() {
  clearSecurityCooldown()
  if ($('securityCaptchaDialog').open) $('securityCaptchaDialog').close()
  if ($('securityDialog').open) $('securityDialog').close()
}

function securityContactDialog(type) {
  const isEmail = type === 'email'
  const current = state.user?.[type] || ''
  const changing = Boolean(current)
  const label = isEmail ? '邮箱' : '手机号'
  const action = changing ? '更换' : '绑定'
  const masked = isEmail ? maskEmail(current) : maskPhone(current)
  const inputType = isEmail ? 'email' : 'tel'
  const autocomplete = isEmail ? 'email' : 'tel'
  const placeholder = isEmail ? 'name@example.com' : '请输入常用手机号'
  return `<form id="securityContactForm" class="security-sheet contact-sheet" novalidate>
    ${dialogHeader(`${action}${label}`,changing ? `验证新${label}后，将替换当前登录与找回方式。` : `绑定后可使用${label}登录并找回密码。`,isEmail ? 'mail' : 'phone')}
    <div class="dialog-step"><span>1</span><strong>填写并验证新${label}</strong><small>验证码 10 分钟内有效</small></div>
    <div class="dialog-form">
      ${changing ? `<div class="current-binding"><span>当前${label}</span><strong>${escapeHtml(masked)}</strong></div>` : ''}
      <label class="form-field full"><span>新${label}</span><div class="verification-input"><input id="securityDestination" type="${inputType}" autocomplete="${autocomplete}" placeholder="${placeholder}" required aria-describedby="securityDestinationHelp securityDestinationError"><button id="securitySendCode" class="button secondary" type="button">发送验证码</button></div><small id="securityDestinationHelp" class="field-help">${isEmail ? '请填写可以正常接收邮件的地址' : '请填写可以正常接收短信的手机号'}</small><small id="securityDestinationError" class="field-error" role="alert"></small></label>
      <label id="securityCodeField" class="form-field full" hidden><span>六位验证码</span><input id="securityCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="请输入收到的验证码" required aria-describedby="securityCodeError"><small id="securityCodeError" class="field-error" role="alert"></small></label>
      ${changing ? `<label class="form-field full"><span>当前登录密码</span><div class="password-input"><input id="securityCurrentPassword" type="password" autocomplete="current-password" placeholder="用于确认是你本人操作" required aria-describedby="securityCurrentPasswordError"><button class="password-toggle" type="button" data-toggle-password="securityCurrentPassword" aria-label="显示当前登录密码">${securityIcon('eye')}</button></div><small id="securityCurrentPasswordError" class="field-error" role="alert"></small></label>` : ''}
      <div id="securityDialogMessage" class="dialog-message" role="status" aria-live="polite"></div>
    </div>
    <div class="dialog-actions"><button class="button quiet" type="button" data-close-security>取消</button><button id="securityContactSubmit" class="button primary" type="submit" disabled>${action}${label}</button></div>
  </form>`
}

function securityPasswordDialog() {
  return `<form id="securityPasswordForm" class="security-sheet" novalidate>
    ${dialogHeader('修改登录密码','修改成功后，所有已登录设备都需要重新登录。','key')}
    <div class="dialog-form">
      <label class="form-field full"><span>当前密码</span><div class="password-input"><input id="securityOldPassword" type="password" autocomplete="current-password" required aria-describedby="securityOldPasswordError"><button class="password-toggle" type="button" data-toggle-password="securityOldPassword" aria-label="显示当前密码">${securityIcon('eye')}</button></div><small id="securityOldPasswordError" class="field-error" role="alert"></small></label>
      <label class="form-field full"><span>新密码</span><div class="password-input"><input id="securityNewPassword" type="password" autocomplete="new-password" minlength="8" maxlength="32" required aria-describedby="securityNewPasswordError securityPasswordRules"><button class="password-toggle" type="button" data-toggle-password="securityNewPassword" aria-label="显示新密码">${securityIcon('eye')}</button></div><small id="securityNewPasswordError" class="field-error" role="alert"></small></label>
      <ul id="securityPasswordRules" class="password-rules" aria-live="polite"><li data-password-rule="length">8–32 位字符</li><li data-password-rule="letter">至少 1 个字母</li><li data-password-rule="number">至少 1 个数字</li></ul>
      <label class="form-field full"><span>确认新密码</span><div class="password-input"><input id="securityConfirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="32" required aria-describedby="securityConfirmPasswordError"><button class="password-toggle" type="button" data-toggle-password="securityConfirmPassword" aria-label="显示确认密码">${securityIcon('eye')}</button></div><small id="securityConfirmPasswordError" class="field-error" role="alert"></small></label>
      <div id="securityDialogMessage" class="dialog-message" role="status" aria-live="polite"></div>
      <div class="security-impact-note">${securityIcon('warning')}<span>保存后主站、AI 实验室和量见智桥的服务器授权都会失效，需要重新登录或授权。</span></div>
    </div>
    <div class="dialog-actions"><button class="button quiet" type="button" data-close-security>取消</button><button class="button primary" type="submit">保存新密码</button></div>
  </form>`
}

function securityLogoutDialog() {
  return `<form id="securityLogoutForm" class="security-sheet" novalidate>
    ${dialogHeader('退出所有登录','这是影响全部设备和桥接授权的安全操作。','logout','危险操作')}
    <div class="logout-impact"><h3>确认退出以下连接？</h3><ul><li>${securityIcon('check')} 当前浏览器中的主站</li><li>${securityIcon('check')} AI 交易实验室</li><li>${securityIcon('check')} 其他已登录设备</li><li>${securityIcon('check')} 量见智桥的服务器授权</li></ul><p>本地 MT4/MT5 通信不受影响；再次使用服务器功能时，需要重新登录或授权。</p></div>
    <div id="securityDialogMessage" class="dialog-message" role="status" aria-live="polite"></div>
    <div class="dialog-actions"><button class="button secondary" type="button" data-close-security>保留登录</button><button class="button danger solid" type="submit">确认退出所有登录</button></div>
  </form>`
}

function openSecurityDialog(action,trigger=document.activeElement) {
  state.securityReturnFocus = trigger instanceof HTMLElement ? trigger : null
  state.securityFlow = action === 'email' || action === 'phone' ? { type:action,changing:Boolean(state.user?.[action]),destination:'' } : { type:action }
  const content = action === 'password' ? securityPasswordDialog() : action === 'logout' ? securityLogoutDialog() : securityContactDialog(action)
  $('securityDialogContent').innerHTML = content
  bindSecurityDialogActions()
  $('securityDialog').showModal()
  const focusTarget = action === 'logout' ? $('securityDialog').querySelector('button[data-close-security]') : $('securityDialog').querySelector('input:not([type="hidden"])')
  focusTarget?.focus()
}

function setFieldError(id,message='') {
  const input = $(id)
  const error = $(`${id}Error`)
  if (error) error.textContent = message
  if (input) input.setAttribute('aria-invalid',message ? 'true' : 'false')
}

function setSecurityMessage(message='',type='') {
  const node = $('securityDialogMessage')
  if (!node) return
  node.textContent = message
  node.className = `dialog-message${type ? ` ${type}` : ''}`
}

function contactDestination() { return $('securityDestination')?.value.trim() || '' }
function validateContactDestination(focus=true) {
  const type = state.securityFlow?.type
  const destination = contactDestination()
  const valid = type === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination) : /^[+\d][\d\s-]{5,19}$/.test(destination)
  const same = String(state.user?.[type] || '').toLowerCase() === destination.toLowerCase()
  const message = !valid ? `请输入有效的${type === 'email' ? '邮箱地址' : '手机号'}` : same ? `新${type === 'email' ? '邮箱' : '手机号'}不能与当前绑定信息相同` : ''
  setFieldError('securityDestination',message)
  if (message && focus) $('securityDestination')?.focus()
  return message ? '' : destination
}

function startSecurityCooldown() {
  clearSecurityCooldown()
  const button = $('securitySendCode')
  if (!button) return
  let seconds = 60
  button.disabled = true
  button.textContent = `${seconds}s 后重发`
  state.securityCooldown = setInterval(() => {
    seconds -= 1
    if (!button.isConnected || seconds <= 0) {
      clearSecurityCooldown()
      if (button.isConnected) { button.disabled = false; button.textContent = '重新发送' }
      return
    }
    button.textContent = `${seconds}s 后重发`
  },1000)
}

async function submitSecurityCaptcha(form) {
  const answer = $('securityCaptchaAnswer').value.trim()
  if (!answer) { $('securityCaptchaError').textContent = '请输入图形验证码'; $('securityCaptchaAnswer').focus(); return }
  const button = $('securityCaptchaSubmit')
  button.disabled = true
  button.textContent = '正在发送…'
  try {
    const { type,changing,destination } = state.securityFlow
    const body = { captchaId:state.securityFlow.captchaId, captchaAnswer:answer, [type]:destination }
    const endpoint = changing ? '/api/send-code' : '/api/send-bind-code'
    if (changing) body.purpose = type === 'email' ? 'change_email' : 'change_phone'
    await api(endpoint,{ method:'POST',body })
    $('securityCaptchaDialog').close()
    $('securityDestination').readOnly = true
    $('securityCodeField').hidden = false
    $('securityContactSubmit').disabled = false
    setSecurityMessage(`验证码已发送至${type === 'email' ? '新邮箱' : '新手机号'}。`,'success')
    startSecurityCooldown()
    $('securityCode').focus()
  } catch(error) {
    $('securityCaptchaError').textContent = error.message || '验证码发送失败，请重试'
    $('securityCaptchaAnswer').focus()
  } finally {
    button.disabled = false
    button.textContent = '发送验证码'
  }
}

async function prepareSecurityCaptcha() {
  const destination = validateContactDestination()
  if (!destination) return
  const button = $('securitySendCode')
  button.disabled = true
  button.textContent = '正在加载…'
  try {
    const result = await api('/api/captcha')
    state.securityFlow.destination = destination
    state.securityFlow.captchaId = result.id
    $('securityCaptchaImage').innerHTML = result.svg || ''
    $('securityCaptchaAnswer').value = ''
    $('securityCaptchaError').textContent = ''
    $('securityCaptchaDialog').showModal()
    $('securityCaptchaAnswer').focus()
  } catch(error) {
    setSecurityMessage(error.message || '图形验证码加载失败，请重试','error')
  } finally {
    if (!state.securityCooldown) { button.disabled = false; button.textContent = '发送验证码' }
  }
}

async function submitSecurityContact(form) {
  const destination = validateContactDestination()
  const code = $('securityCode')?.value.trim() || ''
  const password = $('securityCurrentPassword')?.value || ''
  setFieldError('securityCode',/^\d{6}$/.test(code) ? '' : '请输入六位数字验证码')
  if (state.securityFlow.changing) setFieldError('securityCurrentPassword',password ? '' : '请输入当前登录密码')
  if (!destination || !/^\d{6}$/.test(code) || state.securityFlow.changing && !password) {
    form.querySelector('[aria-invalid="true"]')?.focus()
    return
  }
  const button = $('securityContactSubmit')
  button.disabled = true
  button.textContent = state.securityFlow.changing ? '正在更换…' : '正在绑定…'
  setSecurityMessage()
  try {
    const { type,changing } = state.securityFlow
    const purpose = changing ? (type === 'email' ? 'change_email' : 'change_phone') : 'bind'
    const verified = await api('/api/verify-code',{ method:'POST',body:{ [type]:destination,code,purpose } })
    const endpoint = changing ? `/api/change-${type}` : `/api/bind-${type}`
    const body = changing
      ? { oldPassword:password,[type === 'email' ? 'newEmail' : 'newPhone']:destination,verifyToken:verified.token }
      : { [type]:destination,verifyToken:verified.token }
    await api(endpoint,{ method:'POST',body })
    closeSecurityDialog()
    await refreshProfile()
    toast(`${type === 'email' ? '邮箱' : '手机号'}${changing ? '已更换' : '绑定成功'}`)
  } catch(error) {
    setSecurityMessage(error.message || '操作失败，请检查信息后重试','error')
    button.disabled = false
    button.textContent = state.securityFlow.changing ? `确认更换` : `确认绑定`
  }
}

function updateSecurityPasswordRules() {
  const password = $('securityNewPassword')?.value || ''
  const rules = { length:password.length >= 8 && password.length <= 32,letter:/[A-Za-z]/.test(password),number:/\d/.test(password) }
  Object.entries(rules).forEach(([rule,valid]) => $('securityPasswordRules')?.querySelector(`[data-password-rule="${rule}"]`)?.setAttribute('data-state',valid ? 'valid' : ''))
  const confirm = $('securityConfirmPassword')?.value || ''
  if (confirm) setFieldError('securityConfirmPassword',confirm === password ? '' : '两次输入的新密码不一致')
}

async function submitSecurityPassword(form) {
  const oldPassword = $('securityOldPassword').value
  const newPassword = $('securityNewPassword').value
  const confirmPassword = $('securityConfirmPassword').value
  setFieldError('securityOldPassword',oldPassword ? '' : '请输入当前密码')
  setFieldError('securityNewPassword',newPassword.length >= 8 && newPassword.length <= 32 && /[A-Za-z]/.test(newPassword) && /\d/.test(newPassword) ? '' : '新密码需要 8–32 位，并包含字母和数字')
  setFieldError('securityConfirmPassword',confirmPassword === newPassword ? '' : '两次输入的新密码不一致')
  const invalid = form.querySelector('[aria-invalid="true"]')
  if (invalid) { invalid.focus(); return }
  const button = form.querySelector('[type="submit"]')
  button.disabled = true
  button.textContent = '正在保存…'
  try {
    const result = await api('/api/change-password',{ method:'POST',body:{ oldPassword,newPassword } })
    if (result.relogin) {
      toast('密码已更新，即将返回登录页')
      setTimeout(() => { AuthSession.clear(); notifyParent('account-session-logout'); location.replace(embedMode === 'ai' ? '/ai/auth/?mode=login' : '/auth/login?mode=login') },700)
      return
    }
    closeSecurityDialog()
    toast('密码已更新')
  } catch(error) {
    setSecurityMessage(error.message || '密码修改失败，请重试','error')
    button.disabled = false
    button.textContent = '保存新密码'
  }
}

function togglePasswordVisibility(button) {
  const input = $(button.dataset.togglePassword)
  if (!input) return
  const visible = input.type === 'text'
  input.type = visible ? 'password' : 'text'
  button.setAttribute('aria-label',`${visible ? '显示' : '隐藏'}${input.id === 'securityOldPassword' ? '当前密码' : input.id === 'securityCurrentPassword' ? '当前登录密码' : '密码'}`)
}

function bindSecurityDialogActions() {
  document.querySelectorAll('[data-close-security]').forEach(button => button.addEventListener('click',closeSecurityDialog))
  document.querySelectorAll('[data-toggle-password]').forEach(button => button.addEventListener('click',() => togglePasswordVisibility(button)))
  $('securitySendCode')?.addEventListener('click',prepareSecurityCaptcha)
  $('securityDestination')?.addEventListener('blur',() => validateContactDestination(false))
  $('securityContactForm')?.addEventListener('submit',event => { event.preventDefault(); void submitSecurityContact(event.currentTarget) })
  $('securityPasswordForm')?.addEventListener('submit',event => { event.preventDefault(); void submitSecurityPassword(event.currentTarget) })
  $('securityNewPassword')?.addEventListener('input',updateSecurityPasswordRules)
  $('securityConfirmPassword')?.addEventListener('input',updateSecurityPasswordRules)
  $('securityLogoutForm')?.addEventListener('submit',event => { event.preventDefault(); const button=event.currentTarget.querySelector('[type="submit"]'); button.disabled=true; button.textContent='正在退出…'; void logoutEverywhere() })
}

function planPrice(plan,period) { const row = state.plans?.[plan]?.[period]; return typeof row === 'object' ? Number(row.current || 0) : Number(row || 0) }
function subscriptionTemplate() {
  const current = effectivePlan()
  const activePro = String(state.user?.plan || '').toLowerCase() === 'pro' && !Boolean(state.user?.membershipExpired) && current === 'pro'
  const suffix = state.period === 'year' ? '/年' : '/月'
  const price = plan => money(planPrice(plan,state.period))
  return `<div class="section-stack"><article class="panel"><div class="section-heading"><div><h2>选择会员</h2><p>续费从当前到期时间顺延；付费成功后两个前端同时生效。</p></div><div class="plan-switch"><button data-period="month" class="${state.period === 'month' ? 'active' : ''}">月付</button><button data-period="year" class="${state.period === 'year' ? 'active' : ''}">年付</button></div></div><div class="plan-grid"><article class="plan-card"><header><div><h3>Plus 专业版</h3><p>课程进阶与 AI 观摩</p></div>${current === 'plus' ? '<span class="status-badge paid">当前权益</span>' : ''}</header><div class="plan-price">${price('plus')} <small>${suffix}</small></div><ul class="plan-features"><li>主站进阶课程与学习工具</li><li>AI 实验室观摩模式</li><li>会员到期通知</li></ul>${activePro ? '<p class="plan-disabled-note">当前已是 Pro，无法购买 Plus</p>' : ''}<button class="button secondary" data-buy-plan="plus" ${activePro ? 'disabled aria-disabled="true"' : ''}>${current === 'plus' ? '续费 Plus' : activePro ? 'Pro 用户不可购买 Plus' : '购买 Plus'}</button></article><article class="plan-card recommended"><header><div><h3>Pro 交易版</h3><p>完整 AI 交易工作台</p></div>${current === 'pro' ? '<span class="status-badge paid">当前权益</span>' : '<span class="plan-badge">推荐</span>'}</header><div class="plan-price">${price('pro')} <small>${suffix}</small></div><ul class="plan-features"><li>包含 Plus 全部权益</li><li>连接 MT5 桥接软件</li><li>自动分析、策略与风控</li></ul><button class="button primary" data-buy-plan="pro">${current === 'pro' ? '续费 Pro' : '购买 Pro'}</button></article></div></article><article class="panel info-list"><div class="info-row"><span>当前购买方案</span><strong>${escapeHtml(planLabel(state.user.plan))}${state.user.membershipExpired ? '（已过期）' : ''}</strong></div><div class="info-row"><span>当前有效权限</span><strong>${escapeHtml(planLabel(current))}</strong></div><div class="info-row"><span>到期时间</span><strong>${escapeHtml(formatDate(state.user.planExpiresAt))}</strong></div></article></div>`
}

function ordersTemplate() {
  if (!state.orders) return '<div class="page-loading"><span></span><strong>正在读取支付订单</strong></div>'
  if (!state.orders.length) return '<div class="empty-state"><strong>还没有支付订单</strong><button class="button primary" data-open-tab="subscription">查看会员套餐</button></div>'
  return `<article class="panel"><div class="section-heading"><div><h2>订单记录</h2><p>按创建时间倒序展示，支付状态以服务器为准。</p></div></div><div class="order-list">${state.orders.map(order => `<div class="order-row"><div><strong>${escapeHtml(order.planLabel)} · ${escapeHtml(order.periodLabel)}</strong><small>${escapeHtml(order.orderId)} · ${escapeHtml(formatDate(order.createdAt))}</small></div><span class="status-badge ${order.status === 'paid' ? 'paid' : ['expired','cancelled','failed'].includes(order.status) ? 'failed' : ''}">${escapeHtml(order.statusLabel)}</span><strong class="order-amount">${money(order.amountConfirmed)}</strong></div>`).join('')}</div></article>`
}

function notificationsTemplate() {
  if (!state.notifications) return '<div class="page-loading"><span></span><strong>正在读取消息通知</strong></div>'
  if (!state.notifications.length) return '<div class="empty-state"><strong>暂时没有消息</strong><span>账户、服务与平台的重要动态会显示在这里。</span></div>'
  return `<article class="panel notification-panel"><div class="section-heading"><div><h2>消息通知</h2><p>未读 ${Number(state.notificationUnread || 0)} 条${state.notificationImportantUnacknowledgedCount ? ` · 待确认 ${Number(state.notificationImportantUnacknowledgedCount)} 条` : ''}</p></div>${state.notificationUnread ? '<button id="markNotificationsRead" class="button secondary" type="button">全部标为已读</button>' : ''}</div><div class="order-list notification-list">${state.notifications.map(item => {
    const important = item.priority === 'important' || item.requiresAck
    const safeLink = safeNotificationLink(item.link)
    const acknowledged = Boolean(item.acknowledgedAt)
    const status = acknowledged ? '已确认' : item.requiresAck ? '待确认' : item.isRead ? '已读' : '未读'
    const stateClass = acknowledged ? 'success' : item.requiresAck ? 'warning' : item.isRead ? '' : 'unread'
    return `<article class="notification-item ${important ? 'is-important' : ''} ${item.isRead ? 'is-read' : 'is-unread'}" data-notification-id="${escapeHtml(item.id)}" tabindex="-1"><div class="notification-item-main"><div class="notification-item-heading"><button class="notification-open" data-notification-open="${escapeHtml(item.id)}" type="button" aria-label="${escapeHtml(`${item.isRead ? '查看' : '打开未读'}通知：${item.title || '系统通知'}`)}"><strong>${escapeHtml(item.title || '系统通知')}</strong></button><span class="notification-priority ${important ? 'important' : 'normal'}">${important ? '重要' : '普通'}</span></div><p>${escapeHtml(item.message || '')}</p><small>${escapeHtml(formatDate(item.createdAt))}</small>${safeLink ? `<a class="notification-link" data-notification-link="${escapeHtml(item.id)}" href="${escapeHtml(safeLink)}">查看详情</a>` : ''}</div><div class="notification-item-actions"><span class="status-badge notification-status ${stateClass}">${status}</span>${item.requiresAck && !acknowledged ? `<button class="button primary notification-acknowledge" data-notification-ack="${escapeHtml(item.id)}" type="button">我知道了</button>` : ''}</div></article>`
  }).join('')}</div></article>`
}

function notificationById(id) {
  return (state.notifications || []).find(item => String(item.id) === String(id)) || null
}

async function loadNotificationSummary({ notify=true }={}) {
  if (state.notificationSummaryFlight) return state.notificationSummaryFlight
  state.notificationSummaryFlight = api('/api/notifications/summary')
    .then(result => {
      syncNotificationSummary(notificationSummaryFrom(result),{ notify })
      return result
    })
    .catch(error => {
      // Older deployments do not expose the summary endpoint yet. The list
      // response remains a useful compatibility fallback and must not block
      // the account center.
      return null
    })
    .finally(() => { state.notificationSummaryFlight = null })
  return state.notificationSummaryFlight
}

function focusNotification(id) {
  const row = [...document.querySelectorAll('[data-notification-id]')].find(node => String(node.dataset.notificationId) === String(id))
  if (!row) return
  row.scrollIntoView?.({ block:'center', behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  row.focus({ preventScroll:true })
  state.notificationFocusId = ''
  void markNotificationRead(id,{ silent:true })
}

async function markNotificationRead(id,{ silent=false }={}) {
  const item = notificationById(id)
  if (!item || item.isRead) return true
  try {
    const result = await api('/api/notifications',{ method:'PATCH',body:{ id } })
    item.isRead = true
    item.readAt = new Date().toISOString()
    const summary = notificationSummaryFrom(result)
    if (Number.isFinite(summary.unreadCount)) state.notificationUnread = summary.unreadCount
    else state.notificationUnread = Math.max(0,state.notificationUnread - 1)
    syncNotificationSummary({
      unreadCount:state.notificationUnread,
      importantUnacknowledgedCount:state.notificationImportantUnacknowledgedCount,
      latestImportant:state.notificationLatestImportant,
    })
    if (state.tab === 'notifications') renderTab()
    return true
  } catch (error) {
    if (!silent) toast(error.message || '通知已读状态更新失败','error')
    return false
  }
}

async function openNotification(id) {
  const item = notificationById(id)
  if (!item) return
  await markNotificationRead(id)
  const link = safeNotificationLink(item.link)
  if (link) location.assign(link)
}

async function openNotificationLink(event,link) {
  event.preventDefault()
  const id = link.dataset.notificationLink
  const href = safeNotificationLink(link.getAttribute('href'))
  if (!href) return
  await markNotificationRead(id)
  location.assign(href)
}

async function acknowledgeNotification(id,button) {
  const item = notificationById(id)
  if (!item || !item.requiresAck || item.acknowledgedAt) return
  if (button) { button.disabled = true; button.textContent = '正在确认…' }
  try {
    const result = await api(`/api/notifications/${encodeURIComponent(id)}/acknowledge`,{ method:'POST',body:{} })
    item.acknowledgedAt = result.acknowledgedAt ?? result.acknowledged_at ?? result.notification?.acknowledgedAt ?? result.notification?.acknowledged_at ?? new Date().toISOString()
    item.isRead = true
    const summary = notificationSummaryFrom(result)
    const nextImportantCount = Number.isFinite(summary.importantUnacknowledgedCount)
      ? summary.importantUnacknowledgedCount
      : Math.max(0,state.notificationImportantUnacknowledgedCount - 1)
    syncNotificationSummary({
      unreadCount:Number.isFinite(summary.unreadCount) ? summary.unreadCount : state.notificationUnread,
      importantUnacknowledgedCount:nextImportantCount,
      latestImportant:summary.latestImportant === undefined ? (nextImportantCount ? state.notificationLatestImportant : null) : summary.latestImportant,
    })
    await loadNotificationSummary()
    renderTab()
    toast('重要通知已确认')
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '我知道了' }
    toast(error.message || '确认通知失败','error')
  }
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
  if (state.tab === 'notifications' && state.notifications && state.notificationFocusId) {
    window.setTimeout(() => focusNotification(state.notificationFocusId),0)
  }
}

function bindTabActions() {
  document.querySelectorAll('[data-open-tab]').forEach(button => button.addEventListener('click',() => switchTab(button.dataset.openTab)))
  document.querySelectorAll('[data-security-action]').forEach(button => button.addEventListener('click',() => openSecurityDialog(button.dataset.securityAction,button)))
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click',() => { state.period = button.dataset.period; renderTab() }))
  document.querySelectorAll('[data-buy-plan]').forEach(button => button.addEventListener('click',() => void createPayment(button.dataset.buyPlan,button)))
  $('profileForm')?.addEventListener('submit',event => { event.preventDefault(); void saveProfile(event.currentTarget) })
  $('avatarInput')?.addEventListener('change',event => void saveAvatar(event.target.files?.[0]))
  $('markNotificationsRead')?.addEventListener('click',() => void markNotificationsRead())
  document.querySelectorAll('[data-notification-open]').forEach(button => button.addEventListener('click',() => void openNotification(button.dataset.notificationOpen)))
  document.querySelectorAll('[data-notification-ack]').forEach(button => button.addEventListener('click',() => void acknowledgeNotification(button.dataset.notificationAck,button)))
  document.querySelectorAll('[data-notification-link]').forEach(link => link.addEventListener('click',event => void openNotificationLink(event,link)))
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

async function loadOrders() {
  try { const result=await api('/api/orders'); state.orders=result.orders || []; if(state.tab==='orders') renderTab() }
  catch(error){ toast(error.message,'error'); state.orders=[]; if(state.tab==='orders') renderTab() }
}
async function loadNotifications() {
  try {
    const result=await api('/api/notifications?limit=50')
    const rows = Array.isArray(result.items) ? result.items : Array.isArray(result.notifications) ? result.notifications : []
    state.notifications = Array.isArray(rows) ? rows.map(normalizeNotification) : []
    const summary = notificationSummaryFrom(result)
    syncNotificationSummary({
      unreadCount:summary.unreadCount == null ? state.notificationUnread : summary.unreadCount,
      importantUnacknowledgedCount:summary.importantUnacknowledgedCount,
      latestImportant:summary.latestImportant,
    })
    // Some compatible list endpoints only expose the unread count. Fetch the
    // richer summary separately so the important banner/ack state stays exact.
    if (summary.importantUnacknowledgedCount == null || summary.latestImportant === undefined) void loadNotificationSummary()
    if(state.tab==='notifications') renderTab()
  }
  catch(error){ toast(error.message,'error'); state.notifications=[]; if(state.tab==='notifications') renderTab() }
}
async function markNotificationsRead() {
  try {
    const result = await api('/api/notifications',{ method:'PATCH',body:{ markAll:true } })
    state.notifications=(state.notifications || []).map(item=>({ ...item,isRead:true,readAt:item.readAt || new Date().toISOString() }))
    const summary = notificationSummaryFrom(result)
    syncNotificationSummary({
      unreadCount:summary.unreadCount == null ? 0 : summary.unreadCount,
      importantUnacknowledgedCount:summary.importantUnacknowledgedCount,
      latestImportant:summary.latestImportant,
    })
    renderTab(); toast('全部消息已标为已读')
  }
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

function paymentExpiryTimestamp(value) {
  const raw = String(value || '').trim()
  if (!raw) return Date.now() + 30 * 60 * 1000
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T23:59:59+08:00`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(' ', 'T')}+08:00`
      : raw.replace(' ', 'T')
  const timestamp = new Date(normalized).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now() + 30 * 60 * 1000
}

function stopPaymentCountdown() {
  clearInterval(state.paymentCountdownTimer)
  state.paymentCountdownTimer = null
}

function startPaymentCountdown(expiresAt) {
  stopPaymentCountdown()
  const endAt = paymentExpiryTimestamp(expiresAt)
  const render = () => {
    const countdown = $('paymentCountdown')
    if (!countdown) return stopPaymentCountdown()
    const remaining = Math.max(0, Math.floor((endAt - Date.now()) / 1000))
    const minutes = Math.floor(remaining / 60)
    const seconds = remaining % 60
    countdown.textContent = `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`
    if (remaining === 0) {
      const status = $('paymentStatus')
      if (status) status.textContent = '订单已过期'
      stopPaymentCountdown()
    }
  }
  render()
  state.paymentCountdownTimer = setInterval(render,1000)
}

function openPayment(order) {
  clearInterval(state.paymentTimer)
  stopPaymentCountdown()
  const amount = escapeHtml(order.crypto_amount ?? '0')
  const address = escapeHtml(order.crypto_address || '')
  const confirmations = Number(order.required_confirmations || 1)
  $('paymentDialogContent').innerHTML=`<section class="payment-sheet"><header><div><h2>${escapeHtml(order.label || 'USDT 支付')}</h2><p>请使用 TRC-20 网络转入精确金额，系统会自动确认。</p></div><button class="icon-button" data-close-payment aria-label="关闭">×</button></header><div class="payment-amount-row"><strong>${amount}</strong><span>USDT</span><span class="payment-chain-badge">TRC-20</span></div><div class="payment-qr-section"><div class="payment-qr">${order.qr_code ? `<img src="${escapeHtml(order.qr_code)}" alt="付款二维码">` : '<strong>二维码生成失败，请复制地址付款</strong>'}</div><p class="payment-qr-hint">使用 TRC-20 钱包扫描二维码</p></div><div class="payment-address-section"><span class="payment-field-label">收款地址</span><div class="payment-address-box"><strong id="paymentAddressText">${address}</strong><button class="button secondary payment-copy-button" id="paymentCopyButton" type="button">复制</button></div></div><div class="payment-warning"><span aria-hidden="true">⚠️</span><span>请务必转账 <strong>${amount} USDT</strong> 至上述地址（TRC-20 网络），金额不匹配可能导致到账延迟</span></div><div class="payment-countdown"><span aria-hidden="true">⏱</span><span>请在 <strong id="paymentCountdown">30:00</strong> 内完成支付</span></div><div class="payment-status-row"><span class="payment-status-dot"></span><span id="paymentStatus">等待支付...</span><span class="payment-confirmations">确认数: <strong id="paymentConfirmations">0</strong> / ${confirmations}</span></div><div class="payment-order-meta"><span>订单号<strong>${escapeHtml(order.orderNo || '--')}</strong></span><span>确认要求<strong>${confirmations} 次链上确认</strong></span></div><div class="payment-actions"><button class="button quiet" data-close-payment>稍后支付</button></div></section>`
  $('paymentDialog').showModal()
  document.querySelectorAll('[data-close-payment]').forEach(button=>button.addEventListener('click',()=>$('paymentDialog').close()))
  $('paymentCopyButton')?.addEventListener('click',async event=>{
    const button = event.currentTarget
    button.disabled = true
    try {
      await copyTextWithFallback(order.crypto_address)
      button.textContent = '✓ 已复制'
      toast('收款地址已复制')
    } catch {
      button.textContent = '复制失败'
      toast('复制失败，请手动复制地址','error')
    } finally {
      setTimeout(() => {
        if (!button.isConnected) return
        button.disabled = false
        button.textContent = '复制'
      },2000)
    }
  })
  startPaymentCountdown(order.expires_at)
  state.paymentTimer=setInterval(()=>void pollPayment(order.orderId),5000)
}

async function pollPayment(orderId) {
  try {
    const result=await api(`/api/payment/status/${encodeURIComponent(orderId)}`)
    const host=$('paymentStatus'); if(host) host.textContent=result.statusLabel || result.status
    const confirmations=$('paymentConfirmations'); if(confirmations) confirmations.textContent=Number(result.confirmations || 0)
    const dot=document.querySelector('.payment-status-dot'); if(dot) dot.className=`payment-status-dot ${result.status === 'paid' ? 'success' : ['expired','cancelled','failed'].includes(result.status) ? 'error' : 'pending'}`
    if(result.status==='paid') { clearInterval(state.paymentTimer); stopPaymentCountdown(); toast('支付已确认，会员权益已经更新'); setTimeout(()=>$('paymentDialog').close(),900); state.orders=null; await refreshProfile() }
    if(['expired','cancelled','failed'].includes(result.status)) { clearInterval(state.paymentTimer); stopPaymentCountdown() }
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
    renderIdentity(); setSync();
    void loadNotificationSummary()
    switchTab(new URLSearchParams(location.search).get('tab') || 'overview',{ push:false })
  } catch(error) { $('accountContent').innerHTML=`<div class="empty-state"><strong>账户信息加载失败</strong><span>${escapeHtml(error.message)}</span><button class="button secondary" onclick="location.reload()">重新加载</button></div>`; setSync('同步失败',false) }
}

$('accountNav').addEventListener('click',event=>{ const button=event.target.closest('[data-tab]'); if(button) switchTab(button.dataset.tab) })
$('accountLogoutBtn').addEventListener('click',event=>openSecurityDialog('logout',event.currentTarget))
$('accountCloseBtn').addEventListener('click',()=>embedded ? notifyParent('account-center-close') : history.length > 1 ? history.back() : location.assign('/'))
$('paymentDialog').addEventListener('close',()=>{ clearInterval(state.paymentTimer); stopPaymentCountdown() })
$('securityCaptchaForm').addEventListener('submit',event=>{ event.preventDefault(); void submitSecurityCaptcha(event.currentTarget) })
document.querySelectorAll('[data-close-security-captcha]').forEach(button=>button.addEventListener('click',()=>$('securityCaptchaDialog').close()))
$('securityDialog').addEventListener('close',()=>{ clearSecurityCooldown(); const focus=state.securityReturnFocus; state.securityFlow=null; state.securityReturnFocus=null; if(focus?.isConnected) focus.focus() })
window.addEventListener('keydown',event=>{ if(event.key==='Escape' && embedded && !$('securityDialog').open && !$('securityCaptchaDialog').open && !$('paymentDialog').open){ event.preventDefault(); notifyParent('account-center-close') } })
window.addEventListener('storage',event=>{ if(event.key===AuthSession.eventKey && !AuthSession.token()) location.replace(embedMode === 'ai' ? '/ai/auth/?mode=login' : embedded ? '/auth/login?mode=login' : '/') })
document.addEventListener('visibilitychange',() => { if (!document.hidden) void loadNotificationSummary() })
window.addEventListener('message',event=>{
  if(event.origin!==location.origin || event.source!==window.parent) return
  if(event.data?.type==='account-center-tab') {
    state.notificationFocusId = event.data.notificationId == null ? '' : String(event.data.notificationId)
    switchTab(event.data.tab || 'overview')
  }
  if(event.data?.type==='account-center-theme' && embedMode === 'main') document.body.classList.toggle('account-main-dark',event.data.theme === 'dark')
})

void bootstrap()
