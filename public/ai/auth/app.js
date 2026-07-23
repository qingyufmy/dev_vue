const $ = id => document.getElementById(id)

const state = {
  mode:'login',
  method:'password',
  regType:'email',
  verifyToken:'',
  captcha:null,
  authMethods:{ emailEnabled:true, phoneEnabled:true },
  countdown:0,
  countdownTimer:null,
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
  const raw = $('authAccount')?.value.trim() || ''
  const compact = raw.replace(/\s/g, '')
  const isPhone = /^\+?\d{7,15}$/.test(compact)
  return isPhone ? { phone:compact.startsWith('+') ? compact : `+86${compact}` } : { email:raw.toLowerCase() }
}

function registerAccount() {
  if (state.regType === 'phone') {
    const raw = $('authPhone')?.value.trim().replace(/\s/g, '') || ''
    return { phone:raw.startsWith('+') ? raw : `+86${raw}` }
  }
  return { email:($('authEmail')?.value.trim() || '').toLowerCase() }
}

function setMessage(text = '', type = '') {
  const host = $('authMessage')
  host.textContent = text
  host.className = `auth-message${text ? ' show' : ''}${type ? ` ${type}` : ''}`
}

function fieldError(id, text = '') {
  const host = $(`${id}Error`)
  if (host) host.textContent = text
}

function passwordField(id, label = '密码', autocomplete = 'current-password') {
  return `<label class="form-field" for="${id}"><span>${label}</span><span class="password-wrap"><input id="${id}" type="password" autocomplete="${autocomplete}" minlength="8" maxlength="32" required><button class="password-toggle" type="button" data-password-toggle="${id}">显示</button></span><small id="${id}Error" class="field-error"></small></label>`
}

function codeField() {
  return `<label class="form-field" for="authCode"><span>验证码</span><span class="code-row"><input id="authCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码"><button id="sendCodeBtn" class="button secondary" type="button">发送验证码</button></span><small id="authCodeError" class="field-error"></small></label>`
}

function loginTemplate() {
  const code = state.method === 'code'
  return `<form id="authForm" class="auth-form" novalidate>
    <div class="method-tabs" role="tablist" aria-label="登录方式"><button type="button" class="${code ? '' : 'active'}" data-method="password">密码登录</button><button type="button" class="${code ? 'active' : ''}" data-method="code">验证码登录</button></div>
    <label class="form-field" for="authAccount"><span>邮箱或手机号</span><input id="authAccount" autocomplete="username" inputmode="email" placeholder="邮箱或 +86 手机号" required><small id="authAccountError" class="field-error"></small></label>
    ${code ? codeField() : passwordField('authPassword')}
    <div class="auth-links"><button class="password-toggle" type="button" data-switch-mode="reset">忘记密码</button><span>登录后进入 AI 交易工作台</span></div>
    <button class="button primary auth-submit" type="submit">登录实验室</button>
  </form>`
}

function registerTemplate() {
  const both = state.authMethods.emailEnabled && state.authMethods.phoneEnabled
  const phone = state.regType === 'phone'
  return `<form id="authForm" class="auth-form" novalidate>
    ${both ? `<div class="method-tabs" role="tablist" aria-label="注册方式"><button type="button" class="${phone ? '' : 'active'}" data-reg-type="email">邮箱注册</button><button type="button" class="${phone ? 'active' : ''}" data-reg-type="phone">手机号注册</button></div>` : ''}
    <label class="form-field" for="authNickname"><span>昵称</span><input id="authNickname" autocomplete="nickname" maxlength="32" placeholder="你希望显示的名称" required><small id="authNicknameError" class="field-error"></small></label>
    ${phone
      ? '<label class="form-field" for="authPhone"><span>手机号</span><input id="authPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+86 13800000000" required><small id="authPhoneError" class="field-error"></small></label>'
      : '<label class="form-field" for="authEmail"><span>邮箱</span><input id="authEmail" type="email" autocomplete="email" inputmode="email" placeholder="name@example.com" required><small id="authEmailError" class="field-error"></small></label>'}
    ${codeField()}
    ${passwordField('authPassword','设置密码','new-password')}
    ${passwordField('authConfirmPassword','确认密码','new-password')}
    <label class="inline-check"><input id="tosAgree" type="checkbox" required><span>我已阅读并同意 <a href="/tos" target="_blank">《用户服务协议》</a> 与风险提示</span></label>
    <button class="button primary auth-submit" type="submit">创建账户并进入实验室</button>
  </form>`
}

function resetTemplate() {
  return `<form id="authForm" class="auth-form" novalidate>
    <label class="form-field" for="authAccount"><span>邮箱或手机号</span><input id="authAccount" autocomplete="username" placeholder="注册时使用的邮箱或手机号" required><small id="authAccountError" class="field-error"></small></label>
    ${codeField()}
    ${passwordField('authPassword','新密码','new-password')}
    ${passwordField('authConfirmPassword','确认新密码','new-password')}
    <button class="button primary auth-submit" type="submit">重置密码</button>
    <div class="auth-links"><button class="password-toggle" type="button" data-switch-mode="login">返回登录</button></div>
  </form>`
}

function render() {
  clearCountdown()
  state.verifyToken = ''
  setMessage()
  const reset = state.mode === 'reset'
  $('authModeTabs').hidden = reset
  $('authTitle').textContent = reset ? '找回密码' : state.mode === 'register' ? '创建实验室账户' : '登录实验室'
  $('authEyebrow').textContent = reset ? '账户安全' : state.mode === 'register' ? '开始使用' : '欢迎回来'
  $('authDescription').textContent = reset ? '验证身份后设置新密码。' : state.mode === 'register' ? '注册后可同时登录主站和实验室。' : '使用你的主站账户继续。'
  $('authFormHost').innerHTML = reset ? resetTemplate() : state.mode === 'register' ? registerTemplate() : loginTemplate()
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.mode === state.mode)))
  bindForm()
}

function clearCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer)
  state.countdownTimer = null
  state.countdown = 0
}

function updateCodeButton() {
  const button = $('sendCodeBtn')
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

async function openCaptcha() {
  try {
    await loadCaptcha()
    $('captchaDialog').showModal()
    setTimeout(() => $('captchaAnswer').focus(),50)
  } catch (error) { setMessage(error.message,'error') }
}

async function sendCode(answer) {
  const purpose = state.mode === 'register' ? 'register' : state.mode === 'reset' ? 'reset' : 'login'
  const target = state.mode === 'register' ? registerAccount() : accountValue()
  if (target.email && !/^\S+@\S+\.\S+$/.test(target.email)) throw new Error('请输入有效邮箱')
  if (target.phone && !/^\+\d{8,15}$/.test(target.phone)) throw new Error('请输入有效手机号')
  if (!target.email && !target.phone) throw new Error('请先填写邮箱或手机号')
  const result = await api('/api/send-code',{ method:'POST', body:{ ...target, purpose, captchaId:state.captcha.id, captchaAnswer:answer } })
  if (!result.ok) throw new Error(result.error || '验证码发送失败')
  beginCountdown()
  setMessage(result.message || '验证码已发送，请注意查收','success')
}

async function verifyCode() {
  const code = $('authCode')?.value.trim() || ''
  if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位验证码')
  const purpose = state.mode === 'register' ? 'register' : state.mode === 'reset' ? 'reset' : 'login'
  const target = state.mode === 'register' ? registerAccount() : accountValue()
  const result = await api('/api/verify-code',{ method:'POST', body:{ ...target, code, purpose } })
  if (!result.ok || !result.token) throw new Error(result.error || '验证码无效或已过期')
  state.verifyToken = result.token
  return target
}

function validatePassword() {
  const password = $('authPassword')?.value || ''
  const confirm = $('authConfirmPassword')?.value || ''
  if (password.length < 8 || password.length > 32 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('密码需要 8–32 位，并同时包含字母和数字')
  if (confirm && password !== confirm) throw new Error('两次输入的密码不一致')
  return password
}

async function submitAuth(form) {
  const button = form.querySelector('[type="submit"]')
  button.disabled = true
  setMessage('正在安全验证…')
  try {
    if (state.mode === 'login') {
      const target = accountValue()
      const body = { ...target, method:state.method }
      if (state.method === 'password') body.password = $('authPassword').value
      else body.verifyToken = (await verifyCode(), state.verifyToken)
      const result = await api('/api/login',{ method:'POST', body })
      if (!result.ok || !result.token) throw new Error(result.error || '登录失败')
      AuthSession.persist(result.token,result.user)
      location.replace(safeNext())
      return
    }
    if (state.mode === 'register') {
      const target = await verifyCode()
      const password = validatePassword()
      if (!$('tosAgree').checked) throw new Error('请先阅读并同意用户服务协议')
      const result = await api('/api/register',{ method:'POST', body:{ ...target, password, nickname:$('authNickname').value.trim(), verifyToken:state.verifyToken, authMethod:state.regType, referral:new URLSearchParams(location.search).get('ref') || undefined } })
      if (!result.ok || !result.token) throw new Error(result.error || '注册失败')
      AuthSession.persist(result.token,result.user)
      location.replace(safeNext())
      return
    }
    const target = await verifyCode()
    const password = validatePassword()
    const result = await api('/api/reset-password',{ method:'POST', body:{ ...target, verifyToken:state.verifyToken, newPassword:password } })
    if (!result.ok) throw new Error(result.error || '密码重置失败')
    state.mode = 'login'
    state.method = 'password'
    render()
    setMessage('密码已重置，请使用新密码登录','success')
  } catch (error) {
    setMessage(error.message || '操作失败，请稍后重试','error')
  } finally { button.disabled = false }
}

function bindForm() {
  $('authForm')?.addEventListener('submit', event => { event.preventDefault(); void submitAuth(event.currentTarget) })
  $('sendCodeBtn')?.addEventListener('click', () => void openCaptcha())
  document.querySelectorAll('[data-method]').forEach(button => button.addEventListener('click', () => { state.method = button.dataset.method; render() }))
  document.querySelectorAll('[data-reg-type]').forEach(button => button.addEventListener('click', () => { state.regType = button.dataset.regType; render() }))
  document.querySelectorAll('[data-switch-mode]').forEach(button => button.addEventListener('click', () => { state.mode = button.dataset.switchMode; render() }))
  document.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
    const input = $(button.dataset.passwordToggle)
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    button.textContent = reveal ? '隐藏' : '显示'
  }))
}

async function bootstrap() {
  const params = new URLSearchParams(location.search)
  const requested = params.get('mode')
  if (['login','register','reset'].includes(requested)) state.mode = requested
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
      if (!state.authMethods.emailEnabled) state.regType = 'phone'
    }
  } catch {}
  render()
}

$('authModeTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-mode]')
  if (!button) return
  state.mode = button.dataset.mode
  render()
})
$('captchaImage').addEventListener('click', () => void loadCaptcha())
$('captchaForm').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('captchaSubmit')
  button.disabled = true
  try {
    await sendCode($('captchaAnswer').value.trim())
    $('captchaDialog').close()
  } catch (error) {
    $('captchaError').textContent = error.message
    await loadCaptcha().catch(() => {})
  } finally { button.disabled = false }
})

void bootstrap()
