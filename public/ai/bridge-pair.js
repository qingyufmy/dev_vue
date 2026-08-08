(function () {
  const $ = id => document.getElementById(id)
  const code = String(new URLSearchParams(location.search).get('code') || '').toUpperCase().trim()
  const validCode = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/.test(code)
  const normalizedCode = code.replace(/[^A-Z0-9]/g, '')
  const displayCode = normalizedCode.length === 8
    ? `${normalizedCode.slice(0, 4)}-${normalizedCode.slice(4)}` : '----'

  function setStatus(kind, title, text) {
    $('pairStatus').className = `pair-status ${kind || ''}`.trim()
    $('statusMark').textContent = kind === 'success' ? '✓' : kind === 'error' ? '!' : '…'
    $('statusTitle').textContent = title
    $('statusText').textContent = text
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers:window.AuthSession.headers({ 'Content-Type':'application/json', ...(options.headers || {}) }),
    })
    let data = {}
    try { data = await response.json() } catch {}
    if (response.status === 401) {
      const next = `${location.pathname}${location.search}`
      location.href = `/ai/auth/?mode=login&next=${encodeURIComponent(next)}`
      throw new Error('login_required')
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || data.code || 'request_failed')
      error.code = data.code
      throw error
    }
    return data
  }

  function accountLabel(user) {
    return String(user?.name || user?.nickname || user?.email || user?.phone || `账户 #${user?.id || '--'}`)
  }

  async function initialize() {
    $('pairCode').textContent = displayCode
    if (!validCode) {
      setStatus('error', '授权码无效', '请返回桥接软件，手动点击“连接账号”重新发起授权。')
      return
    }
    if (!window.AuthSession.token()) {
      const next = `${location.pathname}${location.search}`
      location.href = `/ai/auth/?mode=login&next=${encodeURIComponent(next)}`
      return
    }
    try {
      const profile = await api('/api/profile')
      const user = profile.user || profile
      $('currentAccount').textContent = accountLabel(user)
      const select = $('bridgeSource')
      select.append(new Option(`当前账号 · ${accountLabel(user)}`, String(user.id)))
      if (String(user.role || '').toLowerCase() === 'admin') {
        try {
          const result = await api('/api/ai/admin/observer-source-candidates')
          const sources = (result.candidates || []).filter(item =>
            Number(item.id) !== Number(user.id) && item.plan_source === 'observer_source')
          for (const source of sources) {
            const online = source.bridge_online ? ' · 已连接' : ' · 未连接'
            select.append(new Option(`观摩源 · ${accountLabel(source)}${online}`, String(source.id)))
          }
          if (sources.length) $('sourceField').hidden = false
        } catch {}
      }
      $('approvePair').disabled = false
      setStatus('', '等待确认', '请选择正确的连接身份，然后确认本机桥接授权。')
    } catch (error) {
      if (error.message !== 'login_required') {
        setStatus('error', '账户信息读取失败', '请刷新页面后重试。')
      }
    }
  }

  $('approvePair').addEventListener('click', async () => {
    const button = $('approvePair')
    button.disabled = true
    button.textContent = '正在连接…'
    setStatus('', '正在确认授权', '请保持桥接软件运行。')
    try {
      const result = await api('/api/auth/bridge-pair/approve', {
        method:'POST',
        body:JSON.stringify({ userCode:displayCode, bridgeUserId:Number($('bridgeSource').value) }),
      })
      setStatus('success', '连接已确认', result.bridgePlanSource === 'observer_source'
        ? '该桥接档案已连接到所选观摩源，可以关闭此页面。'
        : '量见智桥已获得连接权限，可以关闭此页面。')
      button.textContent = '已连接'
    } catch (error) {
      setStatus('error', '连接未完成', error.code === 'bridge_pair_source_invalid'
        ? '所选观摩源不可用，请返回 AI交易实验室检查配置。'
        : '授权码可能已过期，请在桥接软件中重新发起。')
      button.disabled = false
      button.textContent = '重新确认'
    }
  })

  initialize()
})()
