const $ = id => document.getElementById(id)

const state = {
  mode:'login',
  method:'password',
  regType:'phone',
  loginAccount:'',
  verifyToken:'',
  captcha:null,
  authMethods:{ emailEnabled:true, phoneEnabled:true },
  countdown:0,
  countdownTimer:null,
  flowOpener:null,
}

function safeNext() {
  const raw = new URLSearchParams(location.search).get('next') || '/ai/'
  try {
    const url = new URL(raw, location.origin)
    if (url.origin !== location.origin) return '/ai/'
    if (!url.pathname.startsWith('/ai') && !url.pathname.startsWith('/account')) return '/ai/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch { return '/ai/' }
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers:{ 'Content-Type':'application/json', ...(options.headers || {}) },
    body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  }).then(async response => {
    const data = await response.json().catch(() => ({ ok:false, error:'服务器返回了无法识别的数据' }))
    if (!response.ok && data.ok !== false) data.ok = false
    return data
  })
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char])
}

function accountValue() {
  const id = state.mode === 'reset' ? 'resetAccount' : 'loginAccount'
  const raw = $(id)?.value.trim() || ''
  const compact = raw.replace(/\s/g, '')
  if (!compact) return {}
  const isPhone = /^\+?\d{7,15}$/.test(compact)
  return isPhone ? { phone:compact.startsWith('+') ? compact : `+86${compact}` } : { email:raw.toLowerCase() }
}

function registerAccount() {
  if (state.regType === 'phone') {
    const raw = $('registerPhone')?.value.trim().replace(/\s/g, '') || ''
    return raw ? { phone:raw.startsWith('+') ? raw : `+86${raw}` } : {}
  }
  const email = ($('registerEmail')?.value.trim() || '').toLowerCase()
  return email ? { email } : {}
}

function messageHost() {
  return state.mode === 'login' ? $('authMessage') : $('authFlowMessage')
}

function setMessage(text = '', type = '') {
  const host = messageHost()
  if (!host) return
  host.textContent = text
  host.className = `auth-message${text ? ' show' : ''}${type ? ` ${type}` : ''}`
}

function fieldFeedback(id, text = '', type = 'error') {
  const host = $(`${id}Error`)
  if (host) {
    host.textContent = text
    host.className = `field-error${text && type === 'success' ? ' success' : ''}`
  }
  const input = $(id)
  if (input) input.setAttribute('aria-invalid', text && type === 'error' ? 'true' : 'false')
}

function fieldError(id, text = '') {
  fieldFeedback(id,text,'error')
}

function passwordRuleState(password = '') {
  return {
    length:password.length >= 8 && password.length <= 32,
    letter:/[A-Za-z]/.test(password),
    number:/\d/.test(password)
  }
}

function passwordRequirements(id) {
  const icon = '<span class="password-rule-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="m5.25 8.1 1.7 1.7 3.8-4"/></svg></span>'
  return `<div class="password-guidance" id="${id}Rules" data-state="idle"><span class="password-guidance-title">密码格式要求</span><ul class="password-rule-list" aria-label="密码格式要求"><li data-password-rule="length" data-state="idle">${icon}<span>8–32 位字符</span></li><li data-password-rule="letter" data-state="idle">${icon}<span>至少 1 个字母</span></li><li data-password-rule="number" data-state="idle">${icon}<span>至少 1 个数字</span></li></ul><small class="password-rule-status" id="${id}RuleStatus" aria-live="polite">输入密码后将实时检查格式</small></div>`
}

function passwordField(id, label = '密码', autocomplete = 'current-password', guidance = '') {
  const hint = guidance === 'rules'
    ? passwordRequirements(id)
    : guidance === 'confirm' ? `<small id="${id}Hint" class="field-help">请再次输入完全相同的密码</small>` : ''
  const describedBy = guidance === 'rules' ? `${id}Rules ${id}Error` : guidance === 'confirm' ? `${id}Hint ${id}Error` : `${id}Error`
  return `<div class="form-field"><label for="${id}">${label}</label><span class="password-wrap"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 10 0v3"/><rect x="5" y="11" width="14" height="10" rx="2"/></svg></span><input id="${id}" type="password" autocomplete="${autocomplete}" minlength="8" maxlength="32" aria-describedby="${describedBy}" aria-invalid="false" required><button class="password-toggle" type="button" data-password-toggle="${id}">显示</button></span>${hint}<small id="${id}Error" class="field-error" aria-live="polite"></small></div>`
}

function codeField(prefix, extraClass = '') {
  return `<label class="form-field ${extraClass}" for="${prefix}Code"><span>短信 / 邮件验证码</span><span class="code-row"><span class="input-shell"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6"/></svg></span><input id="${prefix}Code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="请输入 6 位验证码"></span><button class="button secondary" type="button" data-send-code="${state.mode}">发送验证码</button></span><small id="${prefix}CodeError" class="field-error"></small></label>`
}

function loginTemplate() {
  const code = state.method === 'code'
  return `<form class="auth-form auth-form-login" data-auth-form="login" novalidate>
    <div class="method-tabs" role="tablist" aria-label="登录方式"><button type="button" role="tab" aria-selected="${!code}" class="${code ? '' : 'active'}" data-method="password"><span>密码登录</span><small>使用账户密码</small></button><button type="button" role="tab" aria-selected="${code}" class="${code ? 'active' : ''}" data-method="code"><span>验证码登录</span><small>免密码快捷进入</small></button></div>
    <label class="form-field" for="loginAccount"><span>邮箱或手机号</span><span class="input-shell"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><input id="loginAccount" autocomplete="username" inputmode="email" value="${escapeHtml(state.loginAccount)}" placeholder="请输入邮箱或手机号" required></span><small id="loginAccountError" class="field-error"></small></label>
    ${code ? codeField('login') : passwordField('loginPassword')}
    <div class="auth-links"><span>登录后进入 AI 交易工作台</span><button class="text-action" type="button" data-open-auth-flow="reset">忘记密码？</button></div>
    <button class="button primary auth-submit" type="submit"><span>安全登录</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
    <div class="auth-register-entry"><div><strong>首次使用 AI 交易实验室？</strong><small>注册后同步主站会员、订阅和个人配置。</small></div><button class="button secondary" type="button" data-open-auth-flow="register">创建账户</button></div>
  </form>`
}

function registerTemplate() {
  const both = state.authMethods.emailEnabled && state.authMethods.phoneEnabled
  const phone = state.regType === 'phone'
  return `<form class="auth-form auth-form-register" data-auth-form="register" novalidate>
    ${both ? `<div class="method-tabs" role="tablist" aria-label="注册方式"><button type="button" role="tab" aria-selected="${phone}" class="${phone ? 'active' : ''}" data-reg-type="phone"><span>手机号注册</span><small>接收短信验证码</small></button><button type="button" role="tab" aria-selected="${!phone}" class="${phone ? '' : 'active'}" data-reg-type="email"><span>邮箱注册</span><small>接收邮件验证码</small></button></div>` : ''}
    <label class="form-field" for="registerNickname"><span>用户昵称</span><span class="input-shell"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><input id="registerNickname" autocomplete="nickname" maxlength="32" placeholder="你希望显示的名称" required></span><small id="registerNicknameError" class="field-error"></small></label>
    ${phone
      ? '<label class="form-field" for="registerPhone"><span>手机号</span><span class="input-shell"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4M11 18h2"/></svg></span><input id="registerPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+86 13800000000" required></span><small id="registerPhoneError" class="field-error"></small></label>'
      : '<label class="form-field" for="registerEmail"><span>邮箱</span><span class="input-shell"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6"/></svg></span><input id="registerEmail" type="email" autocomplete="email" inputmode="email" placeholder="name@example.com" required></span><small id="registerEmailError" class="field-error"></small></label>'}
    ${codeField('register','register-code-field')}
    ${passwordField('registerPassword','设置密码','new-password','rules')}
    ${passwordField('registerConfirmPassword','确认密码','new-password','confirm')}
    <label class="inline-check"><input id="registerTos" type="checkbox" required><span>我已阅读并同意 <a href="/tos" target="_blank">《用户服务协议》</a> 与风险提示</span></label>
    <div class="auth-flow-actions"><button class="button secondary" type="button" data-close-auth-flow>取消</button><button class="button primary auth-submit" type="submit">创建账户并进入实验室</button></div>
  </form>`
}

function resetTemplate() {
  return `<form class="auth-form auth-form-reset" data-auth-form="reset" novalidate>
    <div class="auth-flow-notice"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7l-8-4Z"/><path d="M12 8v5M12 16v.5"/></svg><span>验证码会发送到账号已绑定的邮箱或手机号。</span></div>
    <label class="form-field" for="resetAccount"><span>邮箱或手机号</span><span class="input-shell"><span class="field-leading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><input id="resetAccount" autocomplete="username" placeholder="注册时使用的邮箱或手机号" required></span><small id="resetAccountError" class="field-error"></small></label>
    ${codeField('reset')}
    ${passwordField('resetPassword','新密码','new-password','rules')}
    ${passwordField('resetConfirmPassword','确认新密码','new-password','confirm')}
    <div class="auth-flow-actions"><button class="button secondary" type="button" data-close-auth-flow>取消</button><button class="button primary auth-submit" type="submit">确认重置密码</button></div>
  </form>`
}

function renderLogin() {
  clearCountdown()
  state.verifyToken = ''
  state.mode = 'login'
  setMessage()
  $('authCard').dataset.mode = 'login'
  document.title = '登录 · AI交易实验室'
  $('authTitle').textContent = '登录实验室'
  $('authEyebrow').textContent = '欢迎回来'
  $('authDescription').textContent = '使用你的主站账户安全进入交易工作区。'
  $('authFormHost').innerHTML = loginTemplate()
  bindForm($('authFormHost'))
}

function syncModeQuery(mode) {
  const url = new URL(location.href)
  url.searchParams.set('mode', mode)
  history.replaceState({},'',`${url.pathname}${url.search}${url.hash}`)
}

function renderAuthFlow() {
  const register = state.mode === 'register'
  $('authFlowDialog').dataset.flow = state.mode
  $('authFlowEyebrow').textContent = register ? '开始使用' : '账户安全'
  $('authFlowTitle').textContent = register ? '创建实验室账户' : '找回账户密码'
  $('authFlowDescription').textContent = register ? '注册后可同时登录主站和 AI 交易实验室。' : '验证绑定的联系方式后设置新密码。'
  $('authFlowHost').innerHTML = register ? registerTemplate() : resetTemplate()
  setMessage()
  bindForm($('authFlowHost'))
}

function openAuthFlow(mode, opener = document.activeElement) {
  if (!['register','reset'].includes(mode)) return
  clearCountdown()
  state.verifyToken = ''
  state.mode = mode
  state.flowOpener = opener instanceof HTMLElement ? opener : null
  renderAuthFlow()
  syncModeQuery(mode)
  const dialog = $('authFlowDialog')
  if (!dialog.open) dialog.showModal()
  setTimeout(() => dialog.querySelector('input')?.focus(),50)
}

function closeAuthFlow() {
  clearCountdown()
  state.verifyToken = ''
  state.mode = 'login'
  if ($('captchaDialog').open) $('captchaDialog').close()
  if ($('authFlowDialog').open) $('authFlowDialog').close()
  syncModeQuery('login')
  const opener = state.flowOpener
  state.flowOpener = null
  if (opener?.isConnected) opener.focus()
}

function clearCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer)
  state.countdownTimer = null
  state.countdown = 0
}

function updateCodeButton() {
  const button = document.querySelector(`[data-send-code="${state.mode}"]`)
  if (!button) return
  button.disabled = state.countdown > 0
  button.textContent = state.countdown > 0 ? `${state.countdown} 秒` : '发送验证码'
}

function beginCountdown() {
  clearCountdown()
  state.countdown = 120
  updateCodeButton()
  state.countdownTimer = setInterval(() => {
    state.countdown -= 1
    updateCodeButton()
    if (state.countdown <= 0) clearCountdown()
  },1000)
}

async function loadCaptcha() {
  const result = await api('/api/captcha')
  if (!result.ok) throw new Error(result.error || '图形验证码加载失败')
  state.captcha = result
  $('captchaImage').innerHTML = result.svg
  $('captchaAnswer').value = ''
  $('captchaError').textContent = ''
}

function codeTargetMeta() {
  if (state.mode === 'register') {
    return {
      target:registerAccount(),
      fieldId:state.regType === 'phone' ? 'registerPhone' : 'registerEmail',
      emptyMessage:state.regType === 'phone' ? '请先填写手机号' : '请先填写邮箱',
    }
  }
  return {
    target:accountValue(),
    fieldId:state.mode === 'reset' ? 'resetAccount' : 'loginAccount',
    emptyMessage:'请先填写邮箱或手机号',
  }
}

function validateCodeTarget() {
  const meta = codeTargetMeta()
  fieldError(meta.fieldId)
  let message = ''
  if (!meta.target.email && !meta.target.phone) message = meta.emptyMessage
  else if (meta.target.email && !/^\S+@\S+\.\S+$/.test(meta.target.email)) message = '请输入有效邮箱'
  else if (meta.target.phone && !/^\+\d{8,15}$/.test(meta.target.phone)) message = '请输入有效手机号'
  if (message) {
    fieldError(meta.fieldId,message)
    $(meta.fieldId)?.focus()
    throw new Error(message)
  }
  return meta.target
}

async function openCaptcha() {
  try {
    validateCodeTarget()
    setMessage()
    await loadCaptcha()
    $('captchaDialog').showModal()
    setTimeout(() => $('captchaAnswer').focus(),50)
  } catch (error) { setMessage(error.message,'error') }
}

function closeCaptcha() {
  state.captcha = null
  $('captchaError').textContent = ''
  if ($('captchaDialog').open) $('captchaDialog').close()
}

async function sendCode(answer) {
  const purpose = state.mode === 'register' ? 'register' : state.mode === 'reset' ? 'reset' : 'login'
  const target = validateCodeTarget()
  const result = await api('/api/send-code',{ method:'POST', body:{ ...target, purpose, captchaId:state.captcha.id, captchaAnswer:answer } })
  if (!result.ok) throw new Error(result.error || '验证码发送失败')
  beginCountdown()
  setMessage(result.message || '验证码已发送，请注意查收','success')
}

async function verifyCode() {
  const prefix = state.mode === 'register' ? 'register' : state.mode === 'reset' ? 'reset' : 'login'
  const code = $(`${prefix}Code`)?.value.trim() || ''
  fieldError(`${prefix}Code`)
  if (!/^\d{6}$/.test(code)) {
    fieldError(`${prefix}Code`,'请输入 6 位验证码')
    $(`${prefix}Code`)?.focus()
    throw new Error('请输入 6 位验证码')
  }
  const purpose = state.mode === 'register' ? 'register' : state.mode === 'reset' ? 'reset' : 'login'
  const target = validateCodeTarget()
  const result = await api('/api/verify-code',{ method:'POST', body:{ ...target, code, purpose } })
  if (!result.ok || !result.token) throw new Error(result.error || '验证码无效或已过期')
  state.verifyToken = result.token
  return target
}

function updatePasswordRules(passwordId) {
  const input = $(passwordId)
  const host = $(`${passwordId}Rules`)
  if (!input || !host) return false
  const password = input.value || ''
  const rules = passwordRuleState(password)
  const hasValue = password.length > 0
  const labels = { length:'8–32 位字符', letter:'至少 1 个字母', number:'至少 1 个数字' }
  const missing = Object.keys(rules).filter(key => !rules[key])
  host.querySelectorAll('[data-password-rule]').forEach(item => {
    const valid = rules[item.dataset.passwordRule]
    item.dataset.state = hasValue ? (valid ? 'valid' : 'invalid') : 'idle'
  })
  host.dataset.state = hasValue ? (missing.length ? 'invalid' : 'valid') : 'idle'
  const status = $(`${passwordId}RuleStatus`)
  if (status) status.textContent = !hasValue
    ? '输入密码后将实时检查格式'
    : missing.length ? `还需满足：${missing.map(key => labels[key]).join('、')}` : '密码格式符合要求'
  input.setAttribute('aria-invalid', hasValue && missing.length ? 'true' : 'false')
  return hasValue && missing.length === 0
}

function updatePasswordConfirmation(passwordId, confirmId) {
  const password = $(passwordId)?.value || ''
  const confirm = $(confirmId)?.value || ''
  if (!confirm) {
    fieldError(confirmId)
    return false
  }
  if (password === confirm) {
    fieldFeedback(confirmId,'两次输入的密码一致','success')
    return true
  }
  fieldError(confirmId,'两次输入的密码不一致')
  return false
}

function bindPasswordValidation(root, passwordId, confirmId) {
  const password = root.querySelector(`#${passwordId}`)
  const confirm = root.querySelector(`#${confirmId}`)
  if (!password || !confirm) return
  const syncPassword = () => {
    fieldError(passwordId)
    updatePasswordRules(passwordId)
    if (confirm.value) updatePasswordConfirmation(passwordId,confirmId)
  }
  password.addEventListener('input',syncPassword)
  password.addEventListener('blur',syncPassword)
  confirm.addEventListener('input',() => updatePasswordConfirmation(passwordId,confirmId))
  confirm.addEventListener('blur',() => updatePasswordConfirmation(passwordId,confirmId))
  updatePasswordRules(passwordId)
}

function validatePassword(passwordId, confirmId = '') {
  const password = $(passwordId)?.value || ''
  const confirm = confirmId ? ($(confirmId)?.value || '') : ''
  fieldError(passwordId)
  if (confirmId) fieldError(confirmId)
  updatePasswordRules(passwordId)
  if (password.length < 8 || password.length > 32 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    fieldError(passwordId,'密码需要 8–32 位，并同时包含字母和数字')
    $(passwordId)?.focus()
    throw new Error('密码需要 8–32 位，并同时包含字母和数字')
  }
  if (confirmId && password !== confirm) {
    fieldError(confirmId,'两次输入的密码不一致')
    $(confirmId)?.focus()
    throw new Error('两次输入的密码不一致')
  }
  if (confirmId) fieldFeedback(confirmId,'两次输入的密码一致','success')
  return password
}

async function submitAuth(form) {
  const button = form.querySelector('.auth-submit')
  const idleHtml = button.innerHTML
  button.disabled = true
  button.setAttribute('aria-busy','true')
  button.textContent = state.mode === 'login' ? '正在登录…' : state.mode === 'register' ? '正在创建账户…' : '正在重置密码…'
  setMessage('正在安全验证…')
  try {
    if (state.mode === 'login') {
      const target = validateCodeTarget()
      const body = { ...target, method:state.method }
      if (state.method === 'password') body.password = validatePassword('loginPassword')
      else body.verifyToken = (await verifyCode(), state.verifyToken)
      const result = await api('/api/login',{ method:'POST', body })
      if (!result.ok || !result.token) throw new Error(result.error || '登录失败')
      AuthSession.persist(result.token,result.user)
      location.replace(safeNext())
      return
    }
    if (state.mode === 'register') {
      const nickname = $('registerNickname').value.trim()
      fieldError('registerNickname')
      if (!nickname) {
        fieldError('registerNickname','请输入用户昵称')
        $('registerNickname').focus()
        throw new Error('请输入用户昵称')
      }
      const password = validatePassword('registerPassword','registerConfirmPassword')
      if (!$('registerTos').checked) {
        $('registerTos').focus()
        throw new Error('请先阅读并同意用户服务协议')
      }
      const target = await verifyCode()
      const result = await api('/api/register',{ method:'POST', body:{ ...target, password, nickname, verifyToken:state.verifyToken, authMethod:state.regType, referral:new URLSearchParams(location.search).get('ref') || undefined } })
      if (!result.ok || !result.token) throw new Error(result.error || '注册失败')
      AuthSession.persist(result.token,result.user)
      location.replace(safeNext())
      return
    }
    const password = validatePassword('resetPassword','resetConfirmPassword')
    const target = await verifyCode()
    const result = await api('/api/reset-password',{ method:'POST', body:{ ...target, verifyToken:state.verifyToken, newPassword:password } })
    if (!result.ok) throw new Error(result.error || '密码重置失败')
    state.method = 'password'
    closeAuthFlow()
    renderLogin()
    setMessage('密码已重置，请使用新密码登录','success')
  } catch (error) {
    setMessage(error.message || '操作失败，请稍后重试','error')
  } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
    button.innerHTML = idleHtml
  }
}

function bindForm(root) {
  root.querySelector('[data-auth-form]')?.addEventListener('submit', event => { event.preventDefault(); void submitAuth(event.currentTarget) })
  root.querySelector('[data-send-code]')?.addEventListener('click', () => void openCaptcha())
  root.querySelector('#loginAccount')?.addEventListener('input', event => { state.loginAccount = event.target.value })
  root.querySelectorAll('[data-method]').forEach(button => button.addEventListener('click', () => {
    state.loginAccount = $('loginAccount')?.value || ''
    state.method = button.dataset.method
    renderLogin()
  }))
  root.querySelectorAll('[data-reg-type]').forEach(button => button.addEventListener('click', () => {
    state.regType = button.dataset.regType
    clearCountdown()
    state.verifyToken = ''
    renderAuthFlow()
    setTimeout(() => (state.regType === 'phone' ? $('registerPhone') : $('registerEmail'))?.focus(),0)
  }))
  root.querySelectorAll('[data-open-auth-flow]').forEach(button => button.addEventListener('click', () => openAuthFlow(button.dataset.openAuthFlow,button)))
  root.querySelectorAll('[data-close-auth-flow]').forEach(button => button.addEventListener('click', closeAuthFlow))
  root.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
    const input = $(button.dataset.passwordToggle)
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    button.textContent = reveal ? '隐藏' : '显示'
  }))
  bindPasswordValidation(root,'registerPassword','registerConfirmPassword')
  bindPasswordValidation(root,'resetPassword','resetConfirmPassword')
}

async function bootstrap() {
  const params = new URLSearchParams(location.search)
  const requested = params.get('mode')
  if (AuthSession.token()) {
    try {
      const response = await fetch('/api/profile',{ headers:AuthSession.headers() })
      if (response.ok) return location.replace(safeNext())
    } catch {}
    AuthSession.clear()
  }
  try {
    const result = await api('/api/auth-methods')
    if (result.ok) {
      state.authMethods = { emailEnabled:result.emailEnabled !== false, phoneEnabled:result.phoneEnabled !== false }
      state.regType = state.authMethods.phoneEnabled ? 'phone' : 'email'
    }
  } catch {}
  renderLogin()
  if (['register','reset'].includes(requested)) openAuthFlow(requested)
}

$('captchaImage').addEventListener('click', () => void loadCaptcha())
$('authFlowDialog').addEventListener('cancel', event => { event.preventDefault(); closeAuthFlow() })
$('authFlowDialog').querySelector('.auth-flow-header [data-close-auth-flow]').addEventListener('click', closeAuthFlow)
$('captchaDialog').addEventListener('cancel', event => { event.preventDefault(); closeCaptcha() })
document.querySelectorAll('[data-close-captcha]').forEach(button => button.addEventListener('click', closeCaptcha))
$('captchaForm').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('captchaSubmit')
  button.disabled = true
  try {
    await sendCode($('captchaAnswer').value.trim())
    closeCaptcha()
  } catch (error) {
    $('captchaError').textContent = error.message
    await loadCaptcha().catch(() => {})
  } finally { button.disabled = false }
})

void bootstrap()
