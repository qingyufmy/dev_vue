const state = {
  view:'overview', profile:null, overview:null, users:[], pagination:null, search:'', membership:'all', page:1, selectedUser:null,
  realtime:{ ws:null, reconnectTimer:null, heartbeatTimer:null, adminPongWatchdogTimer:null, schedulerTimer:null, schedulerSyncTimer:null, schedulerSyncInFlight:false, schedulerSyncRequestSeq:0, reconnectAttempts:0, lastEventAt:0, lastPongAt:0, terminalTime:'', terminalUserId:0, terminalPlatform:'mt5', terminalTimezoneOffsetMinutes:null, pendingRefresh:false, refreshTimer:null, authFailed:false, aiOperationsRequestSeq:0, aiOperationsAbortController:null },
  commercialTab:'orders', commercialOverview:null,
  notificationCenter:{tab:'compose',scope:'user',userId:'',userLabel:'',userSearch:'',userCandidates:[],userSearchTimer:null,userSearchRequestSeq:0,plans:[],title:'',message:'',priority:'normal',link:'',emailEnabled:false,preview:null,previewNotice:'',previewTimer:null,previewRequestSeq:0,createIdempotencyKey:'',campaigns:[],pagination:null,campaignPage:1,selectedCampaign:null,detailPage:1,detailPagination:null,loading:false},
  orderPage:1, orderSearch:'', orderStatus:'all',
  notificationPage:1, notificationSearch:'', notificationStatus:'all', notificationChannel:'all',
  referralStatus:'all',
  aiTab:'health', aiOperations:null, aiGovernance:null, observerCandidates:null,
  modelCompare:{ setup:null, strategyId:0, symbol:'', result:'all', page:1, snapshots:[], pagination:null, selected:new Map(), modelIds:new Set(), jobs:[], loading:false, polling:null },
  platformStrategies:{items:[],models:[],loaded:false,scope:'all',search:''}, strategyDataCapabilities:null, strategyDataCapabilitiesStatus:'idle', strategyDataCapabilitiesRequest:null, platformModels:{profiles:[],policy:null,governance:null,scope:'all',search:''}, platformMemory:null,
  platformMemoryCompressionJob:null, platformMemoryCompressionJobs:{}, platformMemoryCompressionPollTimer:null, platformMemoryCompressionPollKey:null, platformMemoryCompressionPollGeneration:0, platformMemoryCompressionPollInFlight:false, platformMemoryRequestSeq:0, platformMemoryEditorBaseline:null, platformMemoryEditorStrategyId:null, platformMemoryEditorDirty:false, platformMemoryEditorDraft:null, platformMemoryViewMode:'preview', platformMemoryPreview:null, platformMemoryPreviewError:'', platformMemoryConsistencyJob:null, platformMemoryConsistencyPollTimer:null, platformMemoryConsistencyPollKey:null, platformMemoryConsistencyPollGeneration:0, platformMemoryConsistencyPollInFlight:false, platformMemoryConflictOnly:false,
  riskTab:'status', riskData:null, riskPolicy:null, riskPage:1, riskDecision:'all', riskAccountPage:1, riskAccountPageSize:8, auditPage:1, auditSearch:'', auditTarget:'all', riskPolicySearch:'', riskPolicyHasChanges:false,
  contentTab:'courses', contentOverview:null, releaseNotesRevision:'', releaseNotesVersion:0, releaseNotesPreviewTimer:null, contentPage:1, contentSearch:'', contentStatus:'all', feedbackPage:1, feedbackSearch:'', systemConfig:null, systemConfigSecurity:null, systemConfigStorage:null, systemConfigCategory:'plan_prices', systemConfigSearch:'', systemConfigDirty:false, courseAssets:{courses:[],episodeId:0,resources:null,questions:[],editingQuestion:null},
}

const viewLabels = {
  overview:'运营总览',
  users:'用户与会员',
  notifications:'通知中心',
  commercial:'商业运营',
  'ai-operations':'AI 运营',
  'risk-audit':'风控管理',
  'management-audit':'管理审计',
  'content-operations':'内容运营',
  'system-settings':'系统设置',
}

const icons = {
  overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  commercial:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 15h3"/></svg>',
  activity:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 6v6c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-5"/></svg>',
  archive:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8v13H3V8M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.23.35.44.7.6 1 .17.33.5.57.9.6h.1v4h-.1c-.4.03-.73.27-.9.6-.16.3-.37.65-.6 1Z"/></svg>',
  chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/></svg>',
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 11 9-8 9 8v10h-6v-6H9v6H3z"/></svg>',
  menu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0 2 5M20 4v7h-7"/></svg>',
  sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  more:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  book:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z"/></svg>',
  paperclip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m20.5 11.5-8.1 8.1a6 6 0 0 1-8.5-8.5l8.5-8.5a4 4 0 0 1 5.7 5.7l-8.5 8.5a2 2 0 1 1-2.8-2.8l7.8-7.8"/></svg>',
  video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></svg>',
  analytics:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  message:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v13H8l-4 4z"/><path d="M8 9h8M8 13h5"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v5h16v-5"/></svg>',
  file:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v11m0 0 5-5m-5 5-5-5"/><path d="M5 20h14"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  chevron:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 6 6 6-6 6"/></svg>',
  cloud:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 18a5 5 0 0 1-.7-9.95A7 7 0 0 1 20 10a4 4 0 0 1-1 8Z"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4M11 18h2"/></svg>',
  wallet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h14a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13"/><path d="M15 11h7v5h-7a2.5 2.5 0 0 1 0-5Z"/></svg>',
  key:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 4l4 4M14 6l2 2"/></svg>',
  save:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3h14l2 2v16H4z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></svg>',
  rotate:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4v6h6M20 20v-6h-6"/><path d="M5.5 15a8 8 0 0 0 13.2 2M18.5 9A8 8 0 0 0 5.3 7"/></svg>',
  alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17.5v.5"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4L19 6"/></svg>',
}

function renderIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icons[el.dataset.icon]||''})}
renderIcons()

const ADMIN_THEME_KEY = 'ws_theme'
function getAdminTheme() {
  try { return localStorage.getItem(ADMIN_THEME_KEY) === 'dark' ? 'dark' : 'light' }
  catch { return 'light' }
}
function applyAdminTheme(theme = getAdminTheme(), { persist = false } = {}) {
  const nextTheme = theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', nextTheme)
  document.documentElement.style.colorScheme = nextTheme
  if (persist) {
    try { localStorage.setItem(ADMIN_THEME_KEY, nextTheme) } catch {}
  }
  const toggle = document.querySelector('#themeToggleButton')
  if (toggle) {
    const dark = nextTheme === 'dark'
    toggle.setAttribute('aria-pressed', String(dark))
    toggle.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式')
    const icon = toggle.querySelector('[data-theme-icon]')
    if (icon) icon.innerHTML = icons[dark ? 'sun' : 'moon']
    const label = toggle.querySelector('[data-theme-label]')
    if (label) label.textContent = dark ? '切换到浅色模式' : '切换到深色模式'
  }
}
applyAdminTheme(getAdminTheme())

const REALTIME_VIEW_SCOPES = {
  overview:new Set(['overview', 'bridge', 'market', 'risk', 'ai', 'commercial', 'users']),
  users:new Set(['users', 'bridge', 'commercial']),
  notifications:new Set(['commercial', 'users']),
  commercial:new Set(['commercial', 'overview']),
  'ai-operations':new Set(['ai', 'bridge', 'market']),
  'risk-audit':new Set(['risk', 'bridge', 'market', 'ai']),
  'management-audit':new Set(['system', 'risk', 'ai', 'commercial', 'users']),
  'content-operations':new Set(['content']),
  'system-settings':new Set(['system']),
}

function adminRealtimeStatus(kind, text, title = text) {
  const root = document.querySelector('#adminRealtimeStatus')
  const label = document.querySelector('#adminRealtimeStatusText')
  if (!root || !label) return
  root.dataset.state = kind
  label.textContent = text
  root.setAttribute('aria-label', text)
  root.title = title
  const aiRealtime = document.querySelector('.ai-ops-realtime')
  const aiRealtimeState = document.querySelector('#aiOpsRealtimeState')
  if (aiRealtime) {
    const live = kind === 'live'
    aiRealtime.classList.toggle('is-live', live)
    aiRealtime.querySelector('.provider-dot')?.classList.toggle('ok', live)
    if (aiRealtimeState) aiRealtimeState.textContent = live ? 'WSS 实时推送' : kind === 'error' ? '实时认证失败' : '实时通道重连中'
  }
}

function formatRealtimeTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(date)
}

function formatTerminalTime(value, timezoneOffsetMinutes = state.realtime.terminalTimezoneOffsetMinutes) {
  const raw = String(value || '').trim()
  if (!raw) return '--:--:--'
  const match = raw.match(/(?:^|\s)(\d{1,2}:\d{2}:\d{2})(?:\.\d+)?$/)
  if (match?.[1]) return match[1].padStart(8, '0')
  const timestamp = Date.parse(raw)
  const offset = Number(timezoneOffsetMinutes)
  if (!Number.isFinite(timestamp) || !Number.isFinite(offset)) return raw
  const shifted = new Date(timestamp + offset * 60_000)
  return [shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds()]
    .map(value => String(value).padStart(2, '0')).join(':')
}

function normalizeTerminalPlatform(value) {
  return String(value || '').trim().toLowerCase() === 'mt4' ? 'mt4' : 'mt5'
}

function terminalPlatformLabel(value = state.realtime.terminalPlatform) {
  return normalizeTerminalPlatform(value).toUpperCase()
}

function updateAiOpsTerminalClock(value, userId = 0, platform = '', timezoneOffsetMinutes = null) {
  if (platform) state.realtime.terminalPlatform = normalizeTerminalPlatform(platform)
  const offset = Number(timezoneOffsetMinutes)
  if (Number.isFinite(offset)) state.realtime.terminalTimezoneOffsetMinutes = offset
  const label = terminalPlatformLabel()
  document.querySelectorAll('[data-terminal-platform-label]').forEach(node => { node.textContent = label })
  if (!value) return
  state.realtime.terminalTime = String(value)
  state.realtime.terminalUserId = Number(userId || state.realtime.terminalUserId || 0)
  const node = document.querySelector('#aiOpsRealtimeLastAt')
  if (node) {
    node.textContent = formatTerminalTime(value, state.realtime.terminalTimezoneOffsetMinutes)
    node.title = `${label} 原始时间：${String(value)}`
  }
}

function schedulerRemainingSeconds(item, nowMs = Date.now()) {
  const deadline = Date.parse(String(item?.next_run_at_utc || ''))
  if (Number.isFinite(deadline)) return Math.max(0, Math.ceil((deadline - nowMs) / 1000))
  return Math.max(0, Number(item?.next_run_in_seconds || 0))
}

function patchSchedulerRealtime(message) {
  if (message?.scope !== 'ai' || !['scheduler_state','auto_progress','auto_progress_done'].includes(message.reason)) return false
  const runtime = state.aiOperations?.scheduler?.runtime
  if (!Array.isArray(runtime)) return false
  const data = message.data || {}
  const item = runtime.find(row => (data.key && String(row.key || '') === String(data.key))
    || (Number(row.strategy_id) === Number(data.prompt_type_id ?? data.strategy_id)
      && String(row.symbol || '') === String(data.symbol || '')))
  if (!item) return false
  if (message.reason === 'scheduler_state') {
    Object.assign(item, {
      running:data.running !== false,
      in_flight:Boolean(data.in_flight),
      wait_reason:String(data.wait_reason || ''),
      last_error:String(data.last_error || ''),
      stage:String(data.stage || item.stage || 'idle'),
      stage_label:String(data.stage_label || item.stage_label || ''),
      progress_percent:Number(data.progress_percent ?? item.progress_percent ?? 0),
      progress_seq:Number(data.progress_seq ?? item.progress_seq ?? 0),
      subscriber_count:Number(data.subscriber_count ?? item.subscriber_count ?? 0),
      next_run_in_seconds:Number(data.next_run_in_seconds ?? 0),
      next_run_at_utc:String(data.next_run_at_utc || ''),
      state_updated_at_utc:String(data.updated_at || item.state_updated_at_utc || ''),
    })
  } else if (message.reason === 'auto_progress') {
    Object.assign(item, { running:data.running !== false, in_flight:true, wait_reason:'', last_error:'', stage:data.stage || item.stage, stage_label:data.stage_label || item.stage_label, progress_percent:Number(data.progress_percent || 0), subscriber_count:Number(data.subscribers_count ?? item.subscriber_count) })
    if (data.next_run_at_utc !== undefined) item.next_run_at_utc = String(data.next_run_at_utc || '')
    if (data.updated_at) item.state_updated_at_utc = String(data.updated_at)
  } else {
    const failed = data.status && !['success','skipped'].includes(data.status)
    Object.assign(item, { running:data.running !== false, in_flight:false, stage:'idle', stage_label:'', progress_percent:Number(data.progress_percent || 0), next_run_in_seconds:Number(data.next_run_in_seconds || 0), next_run_at_utc:String(data.next_run_at_utc || ''), wait_reason:failed ? String(data.reason || '') : '', last_error:data.status === 'failed' ? String(data.reason || '') : '' })
    if (data.updated_at) item.state_updated_at_utc = String(data.updated_at)
  }
  if (state.view === 'ai-operations' && state.aiTab === 'scheduler' && !adminHasTransientInteraction({ ignoreNavigationInput:true })) renderAiOperationsContent()
  return true
}

function realtimeEventAffectsView(event) {
  const scopes = Array.isArray(event?.scopes) && event.scopes.length ? event.scopes : [event?.scope]
  if (scopes.includes('all')) return true
  const allowed = REALTIME_VIEW_SCOPES[state.view] || new Set([state.view])
  return scopes.some(scope => allowed.has(scope))
}

function adminHasTransientInteraction({ ignoreNavigationInput = false } = {}) {
  const openModal = [...document.querySelectorAll('.modal-layer')].some(item => !item.hidden)
  const active = document.activeElement
  const tagName = active?.tagName || ''
  const navigationInput = active?.id === 'adminQuickNavSearch'
  return openModal || (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) && !(ignoreNavigationInput && navigationInput))
}

function scheduleAdminRealtimeRefresh() {
  const schedulerPage = state.view === 'ai-operations' && state.aiTab === 'scheduler'
  if (adminHasTransientInteraction({ ignoreNavigationInput:schedulerPage })) {
    state.realtime.pendingRefresh = true
    adminRealtimeStatus('pending', '有新数据待更新', '当前正在编辑，完成后会自动更新')
    return
  }
  if (state.realtime.refreshTimer) return
  state.realtime.refreshTimer = setTimeout(async () => {
    state.realtime.refreshTimer = null
    state.realtime.pendingRefresh = false
    try {
      const currentSchedulerPage = state.view === 'ai-operations' && state.aiTab === 'scheduler'
      if (currentSchedulerPage) await loadAiOperations(true)
      else await setView(state.view)
    } catch (error) { handleError(error) }
  }, 550)
}

function flushPendingAdminRealtimeRefresh() {
  const schedulerPage = state.view === 'ai-operations' && state.aiTab === 'scheduler'
  if (state.realtime.pendingRefresh && !adminHasTransientInteraction({ ignoreNavigationInput:schedulerPage })) scheduleAdminRealtimeRefresh()
}

function calibrateSchedulerRuntimeSilently() {
  if (state.view !== 'ai-operations' || state.aiTab !== 'scheduler') return
  if (state.realtime.schedulerSyncInFlight) return
  state.realtime.schedulerSyncInFlight = true
  const requestSeq = ++state.realtime.schedulerSyncRequestSeq
  Promise.resolve(loadAiOperations(true)).catch(error => {
    if (error?.name !== 'AbortError') console.warn('[AdminAI] scheduler calibration failed:', error.message)
  }).finally(() => {
    if (state.realtime.schedulerSyncRequestSeq === requestSeq) state.realtime.schedulerSyncInFlight = false
  })
}

function handleAdminRealtimeMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'admin_ready' || message.type === 'admin_subscribed') {
    if (message.server_time) {
      state.realtime.lastEventAt = Date.parse(message.server_time) || Date.now()
      const clock = formatRealtimeTime(state.realtime.lastEventAt)
      const lastAt = document.querySelector('#adminRealtimeLastAt')
      if (lastAt) lastAt.textContent = clock
    }
    adminRealtimeStatus('live', '实时在线', '已连接服务器实时推送')
    calibrateSchedulerRuntimeSilently()
    return
  }
  if (message.type === 'admin_pong') {
    state.realtime.lastPongAt = Date.now()
    if (message.server_time) state.realtime.lastEventAt = Date.parse(message.server_time) || state.realtime.lastEventAt
    return
  }
  if (message.type !== 'admin_event') return
  state.realtime.lastEventAt = Date.parse(message.changed_at || '') || Date.now()
  const clock = formatRealtimeTime(state.realtime.lastEventAt)
  const lastAt = document.querySelector('#adminRealtimeLastAt')
  if (lastAt) lastAt.textContent = clock
  if (message.reason === 'tick') updateAiOpsTerminalClock(message.data?.quote?.time, message.data?.user_id, message.data?.platform, message.data?.timezone_offset_minutes)
  if (message.reason === 'heartbeat') updateAiOpsTerminalClock(message.data?.mt5_time, message.data?.user_id, message.data?.platform, message.data?.timezone_offset_minutes)
  const schedulerPatched = patchSchedulerRealtime(message)
  adminRealtimeStatus('live', '实时在线', `已接收服务器实时推送，最近更新 ${clock}`)
  if (!schedulerPatched && message.refresh !== false && realtimeEventAffectsView(message)) scheduleAdminRealtimeRefresh()
}

function stopAdminRealtimeHeartbeat() {
  if (state.realtime.heartbeatTimer) {
    clearInterval(state.realtime.heartbeatTimer)
    state.realtime.heartbeatTimer = null
  }
  if (state.realtime.adminPongWatchdogTimer) {
    clearInterval(state.realtime.adminPongWatchdogTimer)
    state.realtime.adminPongWatchdogTimer = null
  }
}

function scheduleAdminRealtimeReconnect() {
  if (state.realtime.authFailed || state.realtime.reconnectTimer) return
  state.realtime.reconnectAttempts += 1
  const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, state.realtime.reconnectAttempts - 1)))
  const seconds = Math.ceil(delayMs / 1000)
  adminRealtimeStatus('waiting', `实时重连中 · ${seconds}s`, '实时通道暂时断开，正在自动重连')
  state.realtime.reconnectTimer = setTimeout(() => {
    state.realtime.reconnectTimer = null
    connectAdminRealtime()
  }, delayMs)
}

function connectAdminRealtime() {
  if (!token() || state.realtime.authFailed) return
  window.AuthSession?.syncCookie()
  const current = state.realtime.ws
  if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) return
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${location.host}/aurum-api/bridge/ws?type=admin`
  adminRealtimeStatus('connecting', '实时连接中', '正在连接服务器实时推送')
  let ws
  try { ws = new WebSocket(url) } catch { scheduleAdminRealtimeReconnect(); return }
  state.realtime.ws = ws
  ws.onopen = () => {
    state.realtime.reconnectAttempts = 0
    state.realtime.lastPongAt = Date.now()
    adminRealtimeStatus('live', '实时在线', '已连接服务器实时推送')
    ws.send(JSON.stringify({ type:'subscribe', scopes:Object.keys(REALTIME_VIEW_SCOPES) }))
    stopAdminRealtimeHeartbeat()
    state.realtime.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      try { ws.send(JSON.stringify({ type:'hb', seq:Date.now() })) } catch {}
    }, 25_000)
    state.realtime.adminPongWatchdogTimer = setInterval(() => {
      if (state.realtime.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - Number(state.realtime.lastPongAt || 0) <= 70_000) return
      adminRealtimeStatus('waiting', '实时连接失活，正在重连', '心跳未收到服务器回应，正在重建实时通道')
      try { ws.close(4001, 'admin_pong_timeout') } catch { scheduleAdminRealtimeReconnect() }
    }, 10_000)
    calibrateSchedulerRuntimeSilently()
  }
  ws.onmessage = event => {
    try { handleAdminRealtimeMessage(JSON.parse(event.data)) } catch {}
  }
  ws.onerror = () => adminRealtimeStatus('waiting', '实时连接异常', '实时通道出现网络异常，正在重连')
  ws.onclose = event => {
    stopAdminRealtimeHeartbeat()
    if (state.realtime.ws === ws) state.realtime.ws = null
    if (event.code === 4002 || event.code === 4003) {
      state.realtime.authFailed = true
      adminRealtimeStatus('error', '实时认证失败', '当前管理员身份无法订阅实时数据')
      return
    }
    scheduleAdminRealtimeReconnect()
  }
}

function token() { return localStorage.getItem('ws_token') || localStorage.getItem('authToken') || '' }
const ADMIN_AI_ERROR_MESSAGES = {
  model_token_limits_invalid: '最大输入和最大输出不能超过上下文窗口，请修改后重试',
  model_token_limits_unconfirmed: '该模型限制尚未确认，请编辑模型并保存验证后再使用、设为默认或绑定策略',
  model_token_limits_stale: '模型身份或限制已变化，请重新编辑并保存验证',
  strategy_memory_version_conflict: '记忆库已被其他操作更新，请刷新后重新编辑',
  strategy_version_conflict: '策略已在其他位置更新，请刷新后对比再保存；当前草稿已保留',
  strategy_indicator_advanced_configuration: '当前 EMA34 使用高级配置，简单开关不会覆盖',
  strategy_data_runtime_confirmation_required: '请确认启用 EMA34 数据计算；这不会自动加入交易规则',
  ema34_timeframe_required: '请先选择 EMA34 计算周期',
  ema34_timeframe_not_in_market_plan: 'EMA34 周期必须来自当前已启用的行情周期',
  indicator_declarations_invalid: '指标数据声明无效，请检查 EMA34 周期后重试',
  indicator_declaration_unsupported: '当前指标声明不受简单编辑器支持，高级配置已保留',
  indicator_declaration_duplicate: '指标数据声明重复，请刷新后重试',
  ema34_declaration_invalid: 'EMA34 数据声明无效，请检查周期后重试',
  strategy_policy_mutation_ambiguous: '高级策略配置无法安全合并，当前草稿已保留',
  strategy_expected_version_invalid: '策略版本信息无效，请刷新策略后重试',
  chan_timeframe_unsupported: '缠论只支持已选行情中的 M5、M15、H1 或 H4 周期',
  strategy_memory_capacity_exceeded: '记忆库已超过容量上限，请先压缩后再保存',
  strategy_memory_compression_output_invalid: '模型返回的压缩结果无效，请重试或人工整理记忆库',
  strategy_memory_compression_stale: '记忆库在压缩期间已更新，本次结果未应用，请重新压缩',
  strategy_memory_compression_job_not_found: '整理任务不存在或已失效，请刷新后重试',
  strategy_memory_library_unavailable: '统一记忆库暂不可用，本次分析已安全取消，请稍后重试',
  strategy_memory_forbidden: '无权访问该策略的记忆库',
  strategy_memory_platform_forbidden: '只有平台内容管理员可以修改平台策略记忆库',
  strategy_memory_strategy_not_active: '该策略当前不可用，无法读取记忆库',
  model_context_window_invalid: '上下文窗口配置无效，请按模型文档修改为正整数',
  model_max_input_tokens_invalid: '最大输入配置无效，请按模型文档修改为正整数',
  model_max_output_tokens_invalid: '最大输出配置无效，请按模型文档修改为正整数',
  model_token_limits_rejected: '当前模型不接受所填限制，请修改上下文窗口、最大输入或最大输出',
  model_input_limit_exceeded: '当前输入超过模型的最大输入限制，请增大配置或减少本次输入',
  model_context_limit_exceeded: '当前请求超过模型上下文窗口，请修改上下文窗口或减少本次输入',
  model_output_limit_exceeded: '当前模型不接受所填最大输出，请按模型文档修改最大输出',
  model_name_invalid: '模型名称不可用，请核对模型名称和接口类型',
  model_protocol_unsupported: '模型调用协议不可用，请核对接口类型和模型服务商',
  model_request_unauthorized: '认证失败，请检查 API Key 或订阅权限',
  model_request_forbidden: '认证失败，请检查 API Key 或订阅权限',
  model_authentication_failed: '认证失败，请检查 API Key 或订阅权限',
  model_rate_limited: '服务商限流，配置尚未完成验证，请稍后再次保存',
  model_request_rate_limited: '服务商限流，配置尚未完成验证，请稍后再次保存',
  model_service_unavailable: '服务暂时不可用，配置尚未完成验证',
  model_connection_timeout: '服务暂时不可用，配置尚未完成验证',
  model_dns_failed: '服务暂时不可用，请检查接口地址后再次保存',
  model_output_incomplete: '模型连接成功但验证输出不完整，请检查思考和最大输出配置',
  model_validation_output_incomplete: '模型连接成功但验证输出不完整，请检查思考和最大输出配置',
  model_connection_auth_failed: '认证失败，请检查 API Key 或订阅权限',
  model_connection_invalid_api_key: '认证失败，请检查 API Key 或订阅权限',
  model_connection_rate_limited: '服务商限流，配置尚未完成验证，请稍后再次保存',
  model_connection_model_unavailable: '模型或调用协议不可用，请核对模型名称和接口类型',
  model_connection_request_rejected: '模型服务拒绝了当前请求，请核对模型名称、调用协议和三个 Token 限制',
  model_connection_token_limits_rejected: '当前模型不接受所填限制，请修改上下文窗口、最大输入或最大输出',
  model_connection_output_incomplete: '模型连接成功但验证输出不完整，请检查思考和最大输出配置',
  model_connection_unavailable: '服务暂时不可用，配置尚未完成验证',
  output_truncated: '模型连接成功但验证输出不完整，请检查思考和最大输出配置',
  ai_response_missing_json_object: '模型连接成功但验证输出不完整，请检查思考和最大输出配置',
}
const ADMIN_MODEL_REQUEST_TIMEOUT_MIN_MS = 30_000
const ADMIN_MODEL_REQUEST_TIMEOUT_MAX_MS = 600_000
const ADMIN_MODEL_REQUEST_TIMEOUT_DEFAULT_MS = 120_000
const ADMIN_MODEL_REQUEST_TRANSPORT_MARGIN_MS = 5_000
function adminModelRequestTransportTimeoutMs(value) {
  const parsed = Number(value)
  const timeout = Number.isFinite(parsed) && parsed >= ADMIN_MODEL_REQUEST_TIMEOUT_MIN_MS
    ? Math.min(ADMIN_MODEL_REQUEST_TIMEOUT_MAX_MS, parsed)
    : ADMIN_MODEL_REQUEST_TIMEOUT_DEFAULT_MS
  return timeout + ADMIN_MODEL_REQUEST_TRANSPORT_MARGIN_MS
}
async function api(path, options = {}) {
  const formBody = typeof FormData !== 'undefined' && options.body instanceof FormData
  const headers = { ...(options.body && !formBody ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
  if (token()) headers.Authorization = `Bearer ${token()}`
  const timeoutMs = Number(options.timeout)
  const controller = !options.signal && Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortController === 'function'
    ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  let response
  try {
    response = await fetch(path, { credentials:'include', ...options, headers, ...(controller ? { signal:controller.signal } : {}) })
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error('请求超时，请检查网络或调大模型请求超时后重试')
      timeoutError.code = 'model_connection_timeout'
      throw timeoutError
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
  const data = await response.json().catch(() => ({ ok:false, error:'服务器返回了无法识别的数据' }))
  if (response.status === 401) {
    location.href = `/auth/login?next=${encodeURIComponent('/admin/')}`
    throw new Error('登录状态已失效')
  }
  if (response.status === 403) {
    location.href = '/'
    throw new Error('当前账号没有管理权限')
  }
  if (!response.ok || data.ok === false) {
    const code = data.error || data.code || ''
    const error = new Error(ADMIN_AI_ERROR_MESSAGES[code] || code || '请求失败，请稍后重试')
    error.status = response.status
    error.code = code
    error.data = data
    throw error
  }
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
function formatMoney(amount, currency = 'USD') {
  const value = Number(amount || 0)
  try { return new Intl.NumberFormat('zh-CN', { style:'currency', currency:currency || 'USD', minimumFractionDigits:2 }).format(value) }
  catch { return `$${value.toFixed(2)}` }
}
const orderStatusLabels = { paid:'已完成', pending:'待支付', processing:'处理中', expired:'已过期', failed:'支付失败', cancelled:'已取消' }
const deliveryStatusLabels = { pending:'待发送', sending:'发送中', sent:'已发送', read:'已阅读', failed:'发送失败', skipped:'已跳过', cancelled:'已取消', waiting_configuration:'等待配置' }
const referralStatusLabels = { pending:'待确认', approved:'已发放', voided:'已作废', rejected:'已拒绝' }
const paymentMethodLabels = { crypto:'数字货币', usdt:'USDT 链上支付', credit:'账户余额', balance:'账户余额', stripe:'银行卡 / Stripe', paypal:'PayPal', alipay:'支付宝', wechat:'微信支付' }
const planDisplayLabels = { pro:'Pro 专业版', plus:'Plus 会员', free:'免费用户', 'Pro monthly':'Pro 专业版', 'Plus monthly':'Plus 会员', 'pro monthly':'Pro 专业版', 'plus monthly':'Plus 会员' }
const periodDisplayLabels = { monthly:'月付', month:'月付', yearly:'年付', annual:'年付', year:'年付', quarterly:'季付', quarter:'季付', one_time:'一次性' }
const channelDisplayLabels = { web:'网页弹窗', email:'邮件', sms:'短信', push:'站内通知' }
function statusBadge(status, labels) {
  const tone = ['paid','sent','read','approved'].includes(status) ? 'active' : ['failed','expired','cancelled','voided','rejected'].includes(status) ? 'expired' : ''
  return `<span class="badge ${tone}">${escapeHtml(labels[status] || '未知状态')}</span>`
}
function displayPlan(value, fallback = '未标注方案') {
  const key = String(value ?? '').trim()
  const normalized=key.toLowerCase().replace(/[-_]/g,' ')
  return planDisplayLabels[key] || (normalized.includes('pro') ? 'Pro 专业版' : normalized.includes('plus') ? 'Plus 会员' : normalized.includes('free') ? '免费用户' : key && /[\u4e00-\u9fff]/.test(key) ? key : fallback)
}
function displayPeriod(value, fallback = '周期未标注') {
  const key = String(value ?? '').trim()
  const normalized=key.toLowerCase().replace(/[-_]/g,' ')
  return periodDisplayLabels[key.toLowerCase()] || (normalized.includes('month') ? '月付' : normalized.includes('year') || normalized.includes('annual') ? '年付' : normalized.includes('quarter') ? '季付' : key && /[\u4e00-\u9fff]/.test(key) ? key : fallback)
}
function displayPaymentMethod(value) {
  const key = String(value ?? '').trim().toLowerCase()
  return paymentMethodLabels[key] || (key && /[\u4e00-\u9fff]/.test(key) ? key : '其他支付方式')
}
function displayChannel(value) { return channelDisplayLabels[String(value ?? '').trim().toLowerCase()] || '网页弹窗' }
function planLabel(user) {
  return displayPlan(user?.plan, '免费用户')
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

function applyAdminProfile(profile) {
  state.profile = profile
  const displayName = profile.nickname || profile.name || profile.email || '管理员'
  document.querySelector('#accountName').textContent = displayName
  document.querySelector('.account-avatar').textContent = displayName.slice(0, 1).toUpperCase()
}
async function loadProfile() {
  const data = await api('/api/profile')
  const profile = data.user || data.profile || data
  if (profile.role !== 'admin') throw new Error('当前账号没有管理权限')
  applyAdminProfile(profile)
}

function metric(label, value, note, primary = false) {
  return `<article class="metric-card ${primary ? 'is-primary' : ''}"><span class="metric-label">${label}</span><div class="metric-value">${Number(value || 0).toLocaleString('zh-CN')}</div><span class="metric-note">${note}</span></article>`
}
function overviewRatio(value, total) {
  const safeTotal = Math.max(0, Number(total) || 0)
  if (!safeTotal) return 0
  return Math.min(100, Math.max(0, Math.round((Number(value || 0) / safeTotal) * 100)))
}
function overviewMetric({ label, value, note, icon, ratio = null, tone = '' }) {
  const progress = ratio === null ? '' : `<div class="overview-metric-progress" aria-label="${escapeHtml(label)}占比 ${ratio}%"><span style="--overview-progress:${ratio}%"></span></div>`
  return `<article class="overview-metric ${tone ? `is-${tone}` : ''}"><header><span class="overview-metric-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></header><strong>${Number(value || 0).toLocaleString('zh-CN')}</strong><footer><small>${escapeHtml(note)}</small>${ratio === null ? '' : `<b>${ratio}%</b>`}</footer>${progress}</article>`
}
async function renderOverview() {
  const main = document.querySelector('#adminMain')
  main.innerHTML = `<header class="page-head overview-page-head"><div><span class="eyebrow">统一运营视图</span><h1>运营总览</h1><p>汇总用户、会员、交易接入和 AI 运营状态。</p></div></header>${skeleton()}`
  const data = await api('/api/admin/overview')
  state.overview = data.overview
  const o = data.overview
  const activeMembers = Number(o.plus_active || 0) + Number(o.pro_active || 0)
  const attentionTotal = Number(o.expired_memberships || 0) + Number(o.pending_reviews || 0)
  const hasAttention = attentionTotal > 0
  const memberRatio = overviewRatio(activeMembers, o.total_users)
  const activityRatio = overviewRatio(o.active_today, o.total_users)
  const connectionRatio = overviewRatio(o.connected_users, o.total_users)
  const reportDate = new Intl.DateTimeFormat('zh-CN', { month:'long', day:'numeric', weekday:'short' }).format(new Date())
  main.innerHTML = `
    <header class="page-head overview-page-head"><div class="overview-title-lockup"><span class="overview-title-icon" aria-hidden="true">${icons.overview}</span><div><span class="eyebrow">统一运营视图</span><h1>运营总览</h1><p>先确认今日态势，再处理异常和进入业务工作区。</p></div></div><div class="overview-head-actions"><div class="overview-report-date"><span>数据日期</span><strong>${reportDate}</strong></div><button class="primary-button" data-go-users type="button">查看用户目录</button></div></header>
    <section class="overview-status-band ${hasAttention ? 'needs-attention' : 'is-clear'}" aria-label="今日运营状态">
      <span class="overview-status-mark" aria-hidden="true">${hasAttention ? icons.alert : icons.check}</span>
      <div class="overview-status-copy"><span>今日运营状态</span><h2>${hasAttention ? `有 ${attentionTotal} 项需要跟进` : '关键运营状态正常'}</h2><p>${hasAttention ? `其中会员到期 ${Number(o.expired_memberships || 0)} 人、周期复盘待处理 ${Number(o.pending_reviews || 0)} 条。` : '会员服务与 AI 复盘队列目前没有待处理事项。'}</p></div>
      <dl class="overview-status-facts"><div><dt>今日新增</dt><dd>+${Number(o.today_new_users || 0).toLocaleString('zh-CN')}</dd></div><div><dt>今日活跃</dt><dd>${Number(o.active_today || 0).toLocaleString('zh-CN')}</dd></div></dl>
    </section>
    <section class="overview-metric-grid" aria-label="核心运营指标">
      ${overviewMetric({ label:'用户总数', value:o.total_users, note:`今日新增 ${o.today_new_users} 人`, icon:icons.users, tone:'primary' })}
      ${overviewMetric({ label:'有效会员', value:activeMembers, note:`Plus ${o.plus_active} · Pro ${o.pro_active}`, icon:icons.commercial, ratio:memberRatio })}
      ${overviewMetric({ label:'今日活跃', value:o.active_today, note:`当前在线 ${o.online_now} 人`, icon:icons.activity, ratio:activityRatio })}
      ${overviewMetric({ label:'MT5 接入用户', value:o.connected_users, note:`共 ${o.trading_accounts} 个交易账户`, icon:icons.chart, ratio:connectionRatio })}
    </section>
    <section class="overview-workspace-grid">
      <article class="panel overview-attention-panel"><header class="section-head"><div><h2>待办与异常</h2><p>按对用户服务和 AI 运行的影响排序。</p></div><span class="overview-count ${hasAttention ? 'has-items' : ''}">${attentionTotal} 项</span></header><div class="overview-task-list">
        <button class="overview-task-row ${Number(o.expired_memberships || 0) ? 'needs-action' : 'is-clear'}" type="button" data-overview-action="expired"><span class="overview-task-icon" aria-hidden="true">${icons.users}</span><div><strong>已过期会员</strong><small>${Number(o.expired_memberships || 0) ? '核对续费与会员服务状态，进入后已自动筛选。' : '当前没有需要跟进的到期会员。'}</small></div><span class="overview-task-value">${Number(o.expired_memberships || 0)}<small>人</small></span><span class="overview-task-arrow" aria-hidden="true">${icons.chevron}</span></button>
        <button class="overview-task-row ${Number(o.pending_reviews || 0) ? 'needs-action' : 'is-clear'}" type="button" data-overview-action="reviews"><span class="overview-task-icon" aria-hidden="true">${icons.activity}</span><div><strong>周期复盘队列</strong><small>${Number(o.pending_reviews || 0) ? '包含待生成、待确认及失败记录，进入 AI 运营处理。' : '周期复盘队列当前没有积压。'}</small></div><span class="overview-task-value">${Number(o.pending_reviews || 0)}<small>条</small></span><span class="overview-task-arrow" aria-hidden="true">${icons.chevron}</span></button>
      </div><footer class="overview-attention-footer"><span>${hasAttention ? '建议先完成以上事项，再检查其他工作区。' : '当前没有集中待办，可继续进行日常运营检查。'}</span><button class="text-button" type="button" data-overview-go="management-audit">查看管理记录</button></footer></article>
      <aside class="panel overview-shortcuts-panel"><header class="section-head"><div><h2>运营工作区</h2><p>常用管理入口集中在这里。</p></div></header><div class="overview-shortcut-list">
        <button type="button" data-overview-go="users"><span>${icons.users}</span><div><strong>用户与会员</strong><small>${Number(o.total_users || 0)} 位用户 · ${activeMembers} 位有效会员</small></div><b aria-hidden="true">${icons.chevron}</b></button>
        <button type="button" data-overview-go="ai-operations"><span>${icons.activity}</span><div><strong>AI 运营</strong><small>${Number(o.pending_reviews || 0)} 条复盘待处理</small></div><b aria-hidden="true">${icons.chevron}</b></button>
        <button type="button" data-overview-go="risk-audit"><span>${icons.shield}</span><div><strong>风控管理</strong><small>账户风险与平台规则</small></div><b aria-hidden="true">${icons.chevron}</b></button>
        <button type="button" data-overview-go="commercial"><span>${icons.commercial}</span><div><strong>商业运营</strong><small>订单、通知与返佣</small></div><b aria-hidden="true">${icons.chevron}</b></button>
      </div></aside>
    </section>`
  main.querySelector('[data-go-users]').addEventListener('click', () => setView('users'))
  main.querySelectorAll('[data-overview-go]').forEach(button => button.addEventListener('click', () => setView(button.dataset.overviewGo)))
  main.querySelector('[data-overview-action="expired"]').addEventListener('click', () => { state.membership = 'expired'; state.page = 1; setView('users') })
  main.querySelector('[data-overview-action="reviews"]').addEventListener('click', () => { state.aiTab = 'memory'; setView('ai-operations') })
}

function commercialTabs() {
  return `<nav class="segment-tabs" aria-label="商业运营分类">
    <button type="button" class="segment-tab ${state.commercialTab === 'orders' ? 'is-active' : ''}" data-commercial-tab="orders">订单与收入</button>
    <button type="button" class="segment-tab ${state.commercialTab === 'notifications' ? 'is-active' : ''}" data-commercial-tab="notifications">到期通知</button>
    <button type="button" class="segment-tab ${state.commercialTab === 'referrals' ? 'is-active' : ''}" data-commercial-tab="referrals">返佣激励</button>
  </nav>`
}

function filterSubmitButton(label = '查询') {
  return `<button class="primary-button filter-submit-button" type="submit"><span aria-hidden="true">${icons.search}</span><span>${escapeHtml(label)}</span></button>`
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
    <article class="metric-card is-primary"><span class="metric-label">累计实收</span><div class="metric-value money-value">${formatMoney(overview.revenue)}</div><span class="metric-note">今日 ${formatMoney(overview.today_revenue)}</span></article>
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
  return `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>订单</th><th>用户</th><th>方案</th><th>订单金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${orders.map(order => `<tr><td><strong>${escapeHtml(order.order_no || order.order_id)}</strong><div class="helper">${escapeHtml(displayPaymentMethod(order.payment_method))}</div></td><td><strong>${escapeHtml(order.user_name || order.user_uid || `用户 #${order.user_id}`)}</strong><div class="helper">${escapeHtml(order.user_email)}</div></td><td>${escapeHtml(displayPlan(order.plan_label || order.plan))}<div class="helper">${escapeHtml(displayPeriod(order.period_label || order.period))}</div></td><td class="mono amount-cell">${formatMoney(order.status === 'paid' ? order.confirmed_amount : order.amount, order.currency)}</td><td>${statusBadge(order.status, orderStatusLabels)}</td><td class="mono">${escapeHtml(formatDate(order.created_at, true))}</td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${orders.map(order => `<article class="mobile-user-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(order.order_no || order.order_id)}</strong><div class="helper">${escapeHtml(order.user_name || order.user_email || `用户 #${order.user_id}`)}</div></div>${statusBadge(order.status, orderStatusLabels)}</div><div class="mobile-business-grid"><span>方案<strong>${escapeHtml(displayPlan(order.plan_label || order.plan))}</strong></span><span>订单金额<strong>${formatMoney(order.status === 'paid' ? order.confirmed_amount : order.amount, order.currency)}</strong></span><span>创建时间<strong>${escapeHtml(formatDate(order.created_at, true))}</strong></span></div></article>`).join('')}</div>`
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
  content.innerHTML = `<form class="filter-bar" id="orderFilters"><div class="field"><label for="orderSearch">搜索订单</label><input class="input" id="orderSearch" placeholder="订单号、用户编号、昵称或邮箱" value="${escapeHtml(state.orderSearch)}"></div><div class="field"><label for="orderStatus">订单状态</label><select class="select" id="orderStatus"><option value="all">全部状态</option><option value="paid">已完成</option><option value="pending">待支付</option><option value="processing">处理中</option><option value="failed">支付失败</option><option value="expired">已过期</option><option value="cancelled">已取消</option></select></div>${filterSubmitButton()}</form><div id="businessListArea">${skeleton(3)}</div><footer class="pagination"><button class="secondary-button" id="businessPrevPage" type="button">上一页</button><span id="businessPageLabel">正在读取…</span><button class="secondary-button" id="businessNextPage" type="button">下一页</button></footer>`
  content.querySelector('#orderStatus').value = state.orderStatus
  content.querySelector('#orderFilters').addEventListener('submit', event => { event.preventDefault(); state.orderSearch = content.querySelector('#orderSearch').value.trim(); state.orderStatus = content.querySelector('#orderStatus').value; state.orderPage = 1; loadCommercialOrders().catch(handleError) })
  await loadCommercialOrders()
}

function notificationRows(records) {
  if (!records.length) return '<div class="empty-state"><div><strong>没有符合条件的通知</strong><p>当前筛选条件下没有发送记录。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>用户</th><th>提醒节点</th><th>渠道</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>${records.map(record => `<tr><td><strong>${escapeHtml(record.nickname || `用户 #${record.user_id}`)}</strong><div class="helper">${escapeHtml(record.email || record.phone || '未配置联系方式')}</div></td><td>${Number(record.days_before) === 0 ? '会员已过期' : `到期前 ${Number(record.days_before)} 天`}<div class="helper">${escapeHtml(displayPlan(record.plan, '未标注方案'))}</div></td><td>${escapeHtml(displayChannel(record.channel))}</td><td>${statusBadge(record.delivery_state, deliveryStatusLabels)}${record.error_text ? `<div class="error-helper">${escapeHtml(record.error_text)}</div>` : ''}</td><td class="mono">${escapeHtml(formatDate(record.updated_at, true))}</td><td>${record.retry_allowed ? `<button class="text-button" type="button" data-retry-notification="${record.id}">重试</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${records.map(record => `<article class="mobile-user-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(record.nickname || `用户 #${record.user_id}`)}</strong><div class="helper">${escapeHtml(displayChannel(record.channel))} · ${Number(record.days_before) === 0 ? '会员已过期' : `到期前 ${Number(record.days_before)} 天`}</div></div>${statusBadge(record.delivery_state, deliveryStatusLabels)}</div>${record.error_text ? `<p class="error-helper">${escapeHtml(record.error_text)}</p>` : ''}${record.retry_allowed ? `<button class="secondary-button compact-action" type="button" data-retry-notification="${record.id}">重新发送</button>` : ''}</article>`).join('')}</div>`
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
  content.innerHTML = `<div class="provider-state" id="providerState">正在检查通知渠道…</div><form class="filter-bar wide-filter" id="notificationFilters"><div class="field"><label for="notificationSearch">搜索用户</label><input class="input" id="notificationSearch" placeholder="昵称、邮箱、手机号或用户编号" value="${escapeHtml(state.notificationSearch)}"></div><div class="field"><label for="notificationChannel">发送渠道</label><select class="select" id="notificationChannel"><option value="all">全部渠道</option><option value="web">网页弹窗</option><option value="email">邮件</option><option value="sms">短信</option></select></div><div class="field"><label for="notificationStatus">发送状态</label><select class="select" id="notificationStatus"><option value="all">全部状态</option><option value="pending">待发送</option><option value="sent">已发送</option><option value="read">已阅读</option><option value="failed">发送失败</option><option value="skipped">已跳过</option><option value="cancelled">已取消</option></select></div>${filterSubmitButton()}</form><div id="businessListArea">${skeleton(3)}</div><footer class="pagination"><button class="secondary-button" id="businessPrevPage" type="button">上一页</button><span id="businessPageLabel">正在读取…</span><button class="secondary-button" id="businessNextPage" type="button">下一页</button></footer>`
  content.querySelector('#notificationChannel').value = state.notificationChannel
  content.querySelector('#notificationStatus').value = state.notificationStatus
  content.querySelector('#notificationFilters').addEventListener('submit', event => { event.preventDefault(); state.notificationSearch = content.querySelector('#notificationSearch').value.trim(); state.notificationChannel = content.querySelector('#notificationChannel').value; state.notificationStatus = content.querySelector('#notificationStatus').value; state.notificationPage = 1; loadCommercialNotifications().catch(handleError) })
  await loadCommercialNotifications()
}

function referralRows(commissions) {
  if (!commissions.length) return '<div class="empty-state"><div><strong>暂无返佣记录</strong><p>当前筛选条件下没有待处理事项。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>邀请人</th><th>受邀用户</th><th>来源订单</th><th>返佣金额</th><th>状态</th><th></th></tr></thead><tbody>${commissions.map(item => `<tr><td><strong>${escapeHtml(item.referrer?.name || item.referrer?.uid || '未知用户')}</strong><div class="helper">${escapeHtml(item.referrer?.email)}</div></td><td>${escapeHtml(item.invited_user?.name || item.invited_user?.uid || '未知用户')}<div class="helper">${escapeHtml(item.invited_user?.email)}</div></td><td>${escapeHtml(item.order_id || '尚未关联订单')}<div class="helper">${escapeHtml([displayPlan(item.plan, '未标注方案'),displayPeriod(item.period, '周期未标注')].filter(Boolean).join(' · '))}</div></td><td class="mono amount-cell">${formatMoney(item.commission_amount)}</td><td>${statusBadge(item.status, referralStatusLabels)}</td><td>${item.status === 'pending' ? `<div class="row-actions"><button class="text-button" type="button" data-referral-action="approve" data-referral-id="${item.id}">确认发放</button><button class="text-button danger-text" type="button" data-referral-action="void" data-referral-id="${item.id}">作废</button></div>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${commissions.map(item => `<article class="mobile-user-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(item.referrer?.name || item.referrer?.uid || '未知用户')}</strong><div class="helper">邀请 ${escapeHtml(item.invited_user?.name || item.invited_user?.uid || '未知用户')}</div></div>${statusBadge(item.status, referralStatusLabels)}</div><div class="mobile-business-grid"><span>返佣金额<strong>${formatMoney(item.commission_amount)}</strong></span><span>来源订单<strong>${escapeHtml(item.order_id || '未关联')}</strong></span></div>${item.status === 'pending' ? `<div class="mobile-actions"><button class="secondary-button" type="button" data-referral-action="void" data-referral-id="${item.id}">作废</button><button class="primary-button" type="button" data-referral-action="approve" data-referral-id="${item.id}">确认发放</button></div>` : ''}</article>`).join('')}</div>`
}

async function loadCommercialReferrals() {
  const params = new URLSearchParams()
  if (state.referralStatus !== 'all') params.set('status', state.referralStatus)
  const [overview, data, ruleData] = await Promise.all([api('/api/admin/referrals/overview'), api(`/api/admin/referrals/commissions?${params}`), api('/api/admin/referrals/rules')])
  document.querySelector('#referralSummary').innerHTML = `<span>累计邀请 <strong>${Number(overview.total || 0).toLocaleString('zh-CN')}</strong></span><span>待确认 <strong>${Number(overview.pending || 0).toLocaleString('zh-CN')}</strong></span><span>已发放 <strong>${formatMoney(overview.stats?.available_credit_amount || overview.totalCommission || 0)}</strong></span>`
  document.querySelector('#businessListArea').innerHTML = referralRows(data.commissions || [])
  renderReferralRules(ruleData.rules || [])
  document.querySelectorAll('[data-referral-action]').forEach(button => button.addEventListener('click', async () => {
    const approve = button.dataset.referralAction === 'approve'
    const title = approve ? '确认发放返佣' : '确认作废返佣'
    const message = approve ? '确认后，返佣金额会计入邀请人的可用余额。该操作不能重复执行。' : '作废后，该条返佣金额将清零，请确认订单确实不符合返佣条件。'
    if (!await confirmAction(title, message, approve ? '确认发放' : '确认作废', !approve)) return
    try { await api(`/api/admin/referrals/commissions/${button.dataset.referralId}`, { method:'PATCH', body:JSON.stringify({ action:button.dataset.referralAction }) }); toast(approve ? '返佣已发放' : '返佣已作废'); await loadCommercialReferrals() } catch (error) { handleError(error) }
  }))
}

function renderReferralRules(rows) {
  const root=document.querySelector('#referralRules');if(!root)return
  const byKey=new Map(rows.map(rule=>[`${rule.plan}:${rule.period}`,rule]))
  const definitions=[['plus','monthly','Plus','月付'],['plus','yearly','Plus','年付'],['pro','monthly','Pro','月付'],['pro','yearly','Pro','年付']]
  root.innerHTML=`<form id="referralRulesForm"><header class="section-head"><div><span class="eyebrow">自动结算参数</span><h2>返佣比例</h2><p>按订单实付金额计算；关闭后新订单不再产生对应返佣。</p></div><button class="primary-button compact-action" type="submit">保存规则</button></header><div class="referral-rule-grid">${definitions.map(([plan,period,planLabel,periodLabel])=>{const rule=byKey.get(`${plan}:${period}`)||{rate_bps:1000,enabled:0};return `<label class="referral-rule-row" data-referral-rule="${plan}:${period}"><span><strong>${planLabel} · ${periodLabel}</strong><small>实付金额返佣</small></span><span class="percentage-input"><input class="input" type="number" min="0" max="100" step="0.1" value="${(Number(rule.rate_bps||0)/100).toFixed(1)}" data-referral-rate><i>%</i></span><span class="switch-copy"><input type="checkbox" data-referral-enabled ${Number(rule.enabled)?'checked':''}><b>${Number(rule.enabled)?'启用':'停用'}</b></span></label>`}).join('')}</div></form>`
  root.querySelectorAll('[data-referral-enabled]').forEach(input=>input.addEventListener('change',()=>{input.nextElementSibling.textContent=input.checked?'启用':'停用'}))
  root.querySelector('#referralRulesForm').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,rules=definitions.map(([plan,period])=>{const row=root.querySelector(`[data-referral-rule="${plan}:${period}"]`);return {plan,period,rate_bps:Math.round(Number(row.querySelector('[data-referral-rate]').value)*100),enabled:row.querySelector('[data-referral-enabled]').checked}});button.disabled=true;try{await api('/api/admin/referrals/rules',{method:'PUT',body:JSON.stringify({rules})});toast('返佣规则已保存','success');await loadCommercialReferrals()}catch(error){handleError(error);button.disabled=false}})
}

async function renderCommercialReferrals() {
  const content = document.querySelector('#commercialContent')
  content.innerHTML = `<section class="panel referral-rules-panel" id="referralRules"><div class="empty-state">正在读取返佣规则…</div></section><div class="referral-summary" id="referralSummary"><span>正在读取返佣数据…</span></div><form class="filter-bar compact-filter" id="referralFilters"><div class="field"><label for="referralStatus">结算状态</label><select class="select" id="referralStatus"><option value="all">全部状态</option><option value="pending">待确认</option><option value="approved">已发放</option><option value="voided">已作废</option></select></div>${filterSubmitButton()}</form><div id="businessListArea">${skeleton(3)}</div>`
  content.querySelector('#referralStatus').value = state.referralStatus
  content.querySelector('#referralFilters').addEventListener('submit', event => { event.preventDefault(); state.referralStatus = content.querySelector('#referralStatus').value; loadCommercialReferrals().catch(handleError) })
  await loadCommercialReferrals()
}

function userRows(users) {
  if (!users.length) return '<div class="empty-state"><div><strong>没有找到符合条件的用户</strong><p>请调整搜索词或会员状态。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table"><thead><tr><th>用户</th><th>会员状态</th><th>MT5 接入</th><th>策略</th><th>最近活跃</th><th></th></tr></thead><tbody>${users.map(user => `<tr data-user-id="${user.id}" tabindex="0"><td><div class="user-identity"><span class="user-avatar">${escapeHtml((user.nickname || user.email || user.phone || '用').slice(0,1))}</span><div><strong>${escapeHtml(user.nickname || '未设置昵称')}</strong><small>${escapeHtml(user.email || user.phone || '未绑定联系方式')}</small></div></div></td><td>${membershipBadge(user)}<div class="helper">${escapeHtml(planLabel(user))}</div></td><td>${user.bridge_connected ? '<span class="badge active">桥接在线</span>' : '<span class="badge">未连接</span>'}<div class="helper">${user.mt5_account_count} 个账户</div></td><td>${user.strategy_count} 条</td><td class="mono">${escapeHtml(formatDate(user.last_seen_at,true))}</td><td><button class="text-button" type="button" data-user-id="${user.id}">查看</button></td></tr>`).join('')}</tbody></table></div>
    <div class="mobile-user-list">${users.map(user => `<button class="mobile-user-card" type="button" data-user-id="${user.id}"><div class="mobile-user-card-head"><div class="user-identity"><span class="user-avatar">${escapeHtml((user.nickname || user.email || user.phone || '用').slice(0,1))}</span><div><strong>${escapeHtml(user.nickname || '未设置昵称')}</strong><small>${escapeHtml(user.email || user.phone || '未绑定联系方式')}</small></div></div>${membershipBadge(user)}</div><div class="mobile-user-card-meta"><span>${user.mt5_account_count} 个 MT5 账户</span><span>${user.strategy_count} 条策略</span></div></button>`).join('')}</div>`
}

async function loadUsers() {
  const params = new URLSearchParams({ page:String(state.page), page_size:'10', membership:state.membership })
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
    <section class="panel"><form class="filter-bar" id="userFilters"><div class="field"><label for="userSearch">搜索用户</label><input class="input" id="userSearch" name="search" placeholder="昵称、邮箱、手机号或用户编号" value="${escapeHtml(state.search)}"></div><div class="field"><label for="membershipFilter">会员状态</label><select class="select" id="membershipFilter"><option value="all">全部用户</option><option value="active">有效会员</option><option value="expired">已过期</option><option value="pro">Pro 专业版</option><option value="plus">Plus 会员</option><option value="free">免费用户</option></select></div>${filterSubmitButton()}</form>
      <div id="userListArea">${skeleton(3)}</div>
      <footer class="pagination"><button class="secondary-button" id="prevPage" type="button">上一页</button><span id="pageLabel">正在读取…</span><button class="secondary-button" id="nextPage" type="button">下一页</button></footer>
    </section>`
  document.querySelector('#membershipFilter').value = state.membership
  document.querySelector('#userFilters').addEventListener('submit', event => { event.preventDefault(); state.search = document.querySelector('#userSearch').value.trim(); state.membership = document.querySelector('#membershipFilter').value; state.page = 1; loadUsers().catch(handleError) })
  document.querySelector('#prevPage').addEventListener('click', () => { if (state.page > 1) state.page -= 1; loadUsers().catch(handleError) })
  document.querySelector('#nextPage').addEventListener('click', () => { if (state.page < state.pagination.total_pages) state.page += 1; loadUsers().catch(handleError) })
  await loadUsers()
}

/* Notification center ---------------------------------------------------- */
const notificationScopeLabels = { user:'指定用户', plans:'按会员类型', all:'全部用户' }
const notificationPlanLabels = { free:'免费用户', plus:'有效 Plus', pro:'有效 Pro', expired:'已过期会员' }
const notificationCampaignStatusLabels = { queued:'排队中', materializing:'整理接收人', sending:'发送中', cancelling:'取消中', needs_review:'待复核', completed:'已完成', partial_failed:'部分失败', cancelled:'已取消', failed:'发送失败' }
const notificationDeliveryStatusLabels = { pending:'待发送', sending:'发送中', sent:'已发送', unknown:'状态未知', failed:'发送失败', skipped:'已跳过', cancelled:'已取消', read:'已阅读', acknowledged:'已确认' }

function notificationDraftPayload({ includePreview = false } = {}) {
  const draft = state.notificationCenter
  const recipientFilter = draft.scope === 'user'
    ? { userId:Number(draft.userId) }
    : draft.scope === 'plans'
      ? { plans:[...draft.plans] }
      : {}
  const payload = {
    recipientScope:draft.scope,
    recipientFilter,
    title:draft.title.trim(),
    message:draft.message.trim(),
    priority:draft.priority,
    link:draft.link.trim() || undefined,
    emailEnabled:Boolean(draft.emailEnabled),
  }
  if (includePreview && draft.preview) {
    payload.previewToken = draft.preview.token
    payload.confirmedRecipientCount = Number(draft.preview.recipientCount ?? draft.preview.recipient_count ?? 0)
  }
  return payload
}

function notificationTextLength(value) {
  return Array.from(String(value || '')).length
}

function notificationDraftIsValid() {
  const draft = state.notificationCenter
  if (notificationTextLength(draft.title.trim()) < 1 || notificationTextLength(draft.title.trim()) > 100) return false
  if (notificationTextLength(draft.message.trim()) < 1 || notificationTextLength(draft.message.trim()) > 1000) return false
  if (draft.scope === 'user' && (!Number.isInteger(Number(draft.userId)) || Number(draft.userId) < 1)) return false
  if (draft.scope === 'plans' && !draft.plans.length) return false
  if (draft.link && !/^\/(?:$|account(?:[\/?]|$)|ai(?:[\/?]|$))/.test(draft.link.trim())) return false
  return true
}

function notificationPreviewValue(preview, camel, snake = '') {
  const value = preview?.[camel] ?? (snake ? preview?.[snake] : undefined)
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function notificationIdempotencyKey(operation) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `${operation}-${uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function notificationPreviewSummaryHtml() {
  const draft = state.notificationCenter
  const preview = draft.preview
  if (draft.previewLoading) return '<div class="notification-summary-state" role="status">正在估算接收人…</div>'
  if (draft.previewError) return `<div class="notification-summary-state is-error" role="alert">${escapeHtml(draft.previewError)}</div>`
  if (!preview || !preview.token) return '<div class="notification-summary-state" role="status">填写接收范围和通知内容后，将在这里显示发送前估算。</div>'
  const recipientCount = notificationPreviewValue(preview, 'recipientCount', 'recipient_count')
  const inAppCount = notificationPreviewValue(preview, 'inAppCount', 'in_app_count')
  const emailReachable = notificationPreviewValue(preview, 'emailReachableCount', 'email_reachable_count')
  const emailSkipped = notificationPreviewValue(preview, 'emailSkippedCount', 'email_skipped_count')
  const excluded = notificationPreviewValue(preview, 'excludedCount', 'excluded_count')
  const sample = Array.isArray(preview.sample) ? preview.sample : []
  const sampleHtml = sample.length
    ? `<ul class="notification-sample-list" aria-label="接收人示例">${sample.slice(0,5).map(item => `<li><strong>${escapeHtml(item.nickname || item.name || `用户 #${item.id ?? item.userId ?? ''}`)}</strong><span>${escapeHtml(item.email || item.uid || item.phone || '联系方式未显示')}</span></li>`).join('')}</ul>`
    : '<p class="notification-summary-note">暂无接收人示例</p>'
  return `${draft.previewNotice ? `<div class="notification-preview-notice" role="status">${escapeHtml(draft.previewNotice)}</div>` : ''}<div class="notification-summary-facts"><div><span>预计接收</span><strong>${recipientCount.toLocaleString('zh-CN')}</strong><small>人</small></div><div><span>站内信</span><strong>${inAppCount.toLocaleString('zh-CN')}</strong><small>人</small></div><div><span>邮件可达</span><strong>${emailReachable.toLocaleString('zh-CN')}</strong><small>人</small></div><div><span>邮件跳过</span><strong>${emailSkipped.toLocaleString('zh-CN')}</strong><small>人</small></div></div><p class="notification-summary-note">${excluded ? `已排除 ${excluded.toLocaleString('zh-CN')} 个不符合条件的账号。` : '未发现额外排除账号。'}</p><div class="notification-sample"><span class="notification-summary-label">接收人示例</span>${sampleHtml}</div>`
}

function renderNotificationComposeSummary() {
  const root = document.querySelector('#notificationSummary')
  if (!root) return
  root.innerHTML = `<header class="notification-summary-heading"><div><span class="eyebrow">发送前检查</span><h2>发送摘要</h2></div><span class="notification-summary-status" aria-hidden="true">${state.notificationCenter.previewLoading ? '估算中' : state.notificationCenter.preview?.token ? '已更新' : '待填写'}</span></header><div class="notification-summary-body" aria-live="polite">${notificationPreviewSummaryHtml()}</div><div class="notification-summary-actions"><p class="field-help">站内信固定创建；开启邮件后，仅向已验证邮箱投递。</p><button class="primary-button" id="notificationSendButton" type="submit" form="notificationComposeForm" ${!notificationDraftIsValid() || !state.notificationCenter.preview?.token || state.notificationCenter.previewLoading ? 'disabled' : ''}>确认并发送</button></div>`
}

function notificationComposeMarkup() {
  const draft = state.notificationCenter
  const checkedPlans = new Set(draft.plans)
  return `<div class="notification-compose-layout"><form class="notification-editor" id="notificationComposeForm" novalidate><fieldset class="notification-fieldset"><legend>接收范围</legend><div class="notification-scope-options"><label class="notification-scope-option"><input type="radio" name="notificationScope" value="user" ${draft.scope === 'user' ? 'checked' : ''}><span><strong>指定用户</strong><small>搜索昵称、邮箱、手机号或 UID</small></span></label><label class="notification-scope-option"><input type="radio" name="notificationScope" value="plans" ${draft.scope === 'plans' ? 'checked' : ''}><span><strong>按会员类型</strong><small>选择一个或多个会员范围</small></span></label><label class="notification-scope-option"><input type="radio" name="notificationScope" value="all" ${draft.scope === 'all' ? 'checked' : ''}><span><strong>全部用户</strong><small>排除管理员和已匿名化账号</small></span></label></div><div class="notification-recipient-fields"><div class="field" id="notificationUserFields" ${draft.scope !== 'user' ? 'hidden' : ''}><label for="notificationUserSearch">搜索用户</label><div class="notification-user-picker"><input class="input" id="notificationUserSearch" type="search" autocomplete="off" value="${escapeHtml(draft.userSearch || draft.userLabel)}" placeholder="昵称、邮箱、手机号或 UID" aria-controls="notificationUserCandidates" aria-expanded="false"><button class="text-button notification-clear-user" id="notificationClearUser" type="button" ${draft.userId ? '' : 'hidden'}>清除</button><input id="notificationUserId" type="hidden" value="${escapeHtml(draft.userId)}"></div><div class="notification-user-candidates" id="notificationUserCandidates" role="listbox" hidden></div><span class="field-help" id="notificationUserHelp">${escapeHtml(draft.userLabel ? `${draft.userLabel}（用户 ID ${draft.userId}）` : '输入至少 2 个字符后显示候选；从用户详情进入时会自动预填。')}</span></div><fieldset class="notification-plan-fields" id="notificationPlanFields" ${draft.scope !== 'plans' ? 'hidden' : ''}><legend>会员类型（至少选择一项）</legend><div class="notification-plan-options">${Object.entries(notificationPlanLabels).map(([value,label]) => `<label><input type="checkbox" name="notificationPlan" value="${value}" ${checkedPlans.has(value) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div></fieldset><div class="notification-all-note" id="notificationAllFields" ${draft.scope !== 'all' ? 'hidden' : ''} role="note"><span data-icon="info" aria-hidden="true"></span><p>全部用户只包含普通用户，管理员、观摩源和已匿名化账号会被排除。发送前需要输入确认词。</p></div></div></fieldset><fieldset class="notification-fieldset notification-content-fieldset"><legend>通知内容</legend><div class="field"><label for="notificationTitle">标题</label><input class="input" id="notificationTitle" maxlength="100" required value="${escapeHtml(draft.title)}" placeholder="请输入通知标题"><small class="notification-character-count"><b id="notificationTitleCount">${notificationTextLength(draft.title)}</b> / 100</small></div><div class="field"><label for="notificationMessage">正文</label><textarea class="input notification-message-input" id="notificationMessage" maxlength="1000" required rows="8" placeholder="请输入纯文本通知内容">${escapeHtml(draft.message)}</textarea><small class="notification-character-count"><b id="notificationMessageCount">${notificationTextLength(draft.message)}</b> / 1000</small></div><fieldset class="notification-priority-field"><legend>通知级别</legend><div class="notification-inline-options"><label><input type="radio" name="notificationPriority" value="normal" ${draft.priority === 'normal' ? 'checked' : ''}><span>普通</span></label><label><input type="radio" name="notificationPriority" value="important" ${draft.priority === 'important' ? 'checked' : ''}><span>重要（需要用户确认）</span></label></div></fieldset><div class="field"><label for="notificationLink">内部链接（可选）</label><input class="input" id="notificationLink" inputmode="url" maxlength="240" value="${escapeHtml(draft.link)}" placeholder="例如 /account/ 或 /ai/"><span class="field-help">仅允许站内 /account/、/ai/ 和首页路径；不支持外部链接。</span></div></fieldset><fieldset class="notification-fieldset notification-channel-fieldset"><legend>发送渠道</legend><label class="notification-channel-row"><input type="checkbox" checked disabled><span><strong>站内信</strong><small>固定开启，确保用户在账户中心可查</small></span></label><label class="notification-channel-row"><input type="checkbox" id="notificationEmailEnabled" ${draft.emailEnabled ? 'checked' : ''}><span><strong>邮件</strong><small>只发送给已验证邮箱；失败会单独记录</small></span></label></fieldset><p class="notification-editor-note" role="note"><span data-icon="info" aria-hidden="true"></span>通知创建后内容、范围和渠道不可编辑；需要修改时请新建通知。</p></form><aside class="notification-summary-panel" id="notificationSummary" aria-label="发送摘要"></aside></div>`
}

function updateNotificationRecipientVisibility(root) {
  const draft = state.notificationCenter
  root.querySelector('#notificationUserFields')?.toggleAttribute('hidden', draft.scope !== 'user')
  root.querySelector('#notificationPlanFields')?.toggleAttribute('hidden', draft.scope !== 'plans')
  root.querySelector('#notificationAllFields')?.toggleAttribute('hidden', draft.scope !== 'all')
}

function notificationUserCandidateLabel(user) {
  return user?.nickname || user?.email || user?.phone || user?.uid || `用户 #${user?.id || ''}`
}

function renderNotificationUserCandidates(root, stateInfo = '') {
  const draft = state.notificationCenter
  const list = root.querySelector('#notificationUserCandidates')
  const input = root.querySelector('#notificationUserSearch')
  if (!list || !input) return
  if (stateInfo === 'loading') {
    list.hidden = false
    list.innerHTML = '<div class="notification-user-candidate-state" role="status">正在搜索用户…</div>'
  } else if (stateInfo === 'error') {
    list.hidden = false
    list.innerHTML = '<div class="notification-user-candidate-state is-error" role="alert">用户搜索暂不可用，请稍后重试。</div>'
  } else if (stateInfo === 'empty') {
    list.hidden = false
    list.innerHTML = '<div class="notification-user-candidate-state">没有找到可发送通知的普通用户。</div>'
  } else if (!draft.userCandidates.length) {
    list.hidden = true
    list.innerHTML = ''
  } else {
    list.hidden = false
    list.innerHTML = draft.userCandidates.map((user, index) => `<button class="notification-user-candidate" type="button" role="option" data-notification-user-index="${index}"><span class="user-avatar" aria-hidden="true">${escapeHtml(notificationUserCandidateLabel(user).slice(0,1))}</span><span><strong>${escapeHtml(notificationUserCandidateLabel(user))}</strong><small>${escapeHtml(user.email || user.phone || user.uid || `用户 #${user.id}`)}${user.plan ? ` · ${escapeHtml(planLabel(user))}` : ''}</small></span></button>`).join('')
    list.querySelectorAll('[data-notification-user-index]').forEach(button => button.addEventListener('click', () => selectNotificationUser(Number(button.dataset.notificationUserIndex), root)))
  }
  input.setAttribute('aria-expanded', String(!list.hidden))
}

function selectNotificationUser(index, root) {
  const draft = state.notificationCenter
  const user = draft.userCandidates[index]
  if (!user?.id) return
  draft.userId = String(user.id)
  draft.userLabel = `${notificationUserCandidateLabel(user)} · ${user.email || user.phone || user.uid || `用户 #${user.id}`}`
  draft.userSearch = draft.userLabel
  draft.userCandidates = []
  root.querySelector('#notificationUserSearch').value = draft.userSearch
  root.querySelector('#notificationUserId').value = draft.userId
  root.querySelector('#notificationUserHelp').textContent = `已选择 ${draft.userLabel}（用户 ID ${draft.userId}）`
  root.querySelector('#notificationClearUser').hidden = false
  renderNotificationUserCandidates(root)
  queueNotificationPreview()
}

function clearNotificationUser(root) {
  const draft = state.notificationCenter
  draft.userId = ''
  draft.userLabel = ''
  draft.userSearch = ''
  draft.userCandidates = []
  root.querySelector('#notificationUserSearch').value = ''
  root.querySelector('#notificationUserId').value = ''
  root.querySelector('#notificationUserHelp').textContent = '输入至少 2 个字符后显示候选；从用户详情进入时会自动预填。'
  root.querySelector('#notificationClearUser').hidden = true
  renderNotificationUserCandidates(root)
  queueNotificationPreview()
}

async function requestNotificationUserSearch(root, query) {
  const draft = state.notificationCenter
  const requestSeq = ++draft.userSearchRequestSeq
  try {
    const params = new URLSearchParams({ search:query, page_size:'10' })
    const data = await api(`/api/admin/users?${params}`)
    if (requestSeq !== draft.userSearchRequestSeq || state.view !== 'notifications') return
    draft.userCandidates = (data.users || []).filter(user => user.role !== 'admin' && user.plan_source !== 'observer_source')
    renderNotificationUserCandidates(root, draft.userCandidates.length ? '' : 'empty')
  } catch (error) {
    if (requestSeq !== draft.userSearchRequestSeq) return
    draft.userCandidates = []
    renderNotificationUserCandidates(root, 'error')
    if (error.status !== 401 && error.status !== 403) toast(error.message || '用户搜索暂不可用', 'error')
  }
}

function queueNotificationUserSearch(root) {
  const draft = state.notificationCenter
  const input = root.querySelector('#notificationUserSearch')
  if (!input) return
  clearTimeout(draft.userSearchTimer)
  draft.userSearchRequestSeq += 1
  const query = input.value.trim()
  draft.userSearch = input.value
  draft.userId = ''
  draft.userLabel = ''
  root.querySelector('#notificationUserId').value = ''
  root.querySelector('#notificationClearUser').hidden = true
  draft.userCandidates = []
  if (query.length < 2) {
    renderNotificationUserCandidates(root)
    queueNotificationPreview()
    return
  }
  renderNotificationUserCandidates(root, 'loading')
  draft.userSearchTimer = setTimeout(() => requestNotificationUserSearch(root, query), 280)
  queueNotificationPreview()
}

function handleNotificationUserSearchKeydown(event, root) {
  const list = root.querySelector('#notificationUserCandidates')
  if (event.key === 'ArrowDown' && list && !list.hidden) {
    event.preventDefault()
    list.querySelector('button')?.focus()
  } else if (event.key === 'Enter' && list && !list.hidden && state.notificationCenter.userCandidates.length) {
    event.preventDefault()
    selectNotificationUser(0, root)
  } else if (event.key === 'Escape') {
    renderNotificationUserCandidates(root)
  }
}

function queueNotificationPreview() {
  const draft = state.notificationCenter
  clearTimeout(draft.previewTimer)
  draft.previewRequestSeq += 1
  draft.preview = null
  draft.previewError = ''
  draft.previewNotice = ''
  draft.createIdempotencyKey = ''
  draft.previewLoading = false
  renderNotificationComposeSummary()
  if (!notificationDraftIsValid()) return
  draft.previewLoading = true
  renderNotificationComposeSummary()
  draft.previewTimer = setTimeout(() => requestNotificationPreview(), 280)
}

async function requestNotificationPreview() {
  const draft = state.notificationCenter
  const requestSeq = ++draft.previewRequestSeq
  if (!notificationDraftIsValid()) return
  try {
    const data = await api('/api/admin/notifications/preview', { method:'POST', body:JSON.stringify(notificationDraftPayload()) })
    if (requestSeq !== draft.previewRequestSeq || state.view !== 'notifications') return
    draft.preview = data.preview || null
    draft.previewError = ''
    draft.previewNotice = ''
  } catch (error) {
    if (requestSeq !== draft.previewRequestSeq) return
    draft.preview = null
    draft.previewError = error.message || '接收人估算失败，请稍后重试'
  } finally {
    if (requestSeq === draft.previewRequestSeq) {
      draft.previewLoading = false
      renderNotificationComposeSummary()
    }
  }
}

function bindNotificationCompose(root) {
  const draft = state.notificationCenter
  const form = root.querySelector('#notificationComposeForm')
  if (!form) return
  const syncDraft = () => {
    draft.title = root.querySelector('#notificationTitle').value
    draft.message = root.querySelector('#notificationMessage').value
    draft.link = root.querySelector('#notificationLink').value
    draft.emailEnabled = root.querySelector('#notificationEmailEnabled').checked
    draft.priority = root.querySelector('[name="notificationPriority"]:checked')?.value || 'normal'
    draft.userId = root.querySelector('#notificationUserId')?.value || draft.userId
    draft.plans = [...root.querySelectorAll('[name="notificationPlan"]:checked')].map(input => input.value)
    root.querySelector('#notificationTitleCount').textContent = notificationTextLength(draft.title)
    root.querySelector('#notificationMessageCount').textContent = notificationTextLength(draft.message)
  }
  root.querySelectorAll('[name="notificationScope"]').forEach(input => input.addEventListener('change', event => {
    draft.scope = event.target.value
    syncDraft()
    updateNotificationRecipientVisibility(root)
    queueNotificationPreview()
  }))
  form.querySelectorAll('input,textarea').forEach(input => {
    if (input.id === 'notificationUserSearch') return
    input.addEventListener('input', () => { syncDraft(); queueNotificationPreview() })
  })
  form.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(input => input.addEventListener('change', () => { syncDraft(); queueNotificationPreview() }))
  root.querySelector('#notificationUserSearch')?.addEventListener('input', () => queueNotificationUserSearch(root))
  root.querySelector('#notificationUserSearch')?.addEventListener('keydown', event => handleNotificationUserSearchKeydown(event, root))
  root.querySelector('#notificationClearUser')?.addEventListener('click', () => clearNotificationUser(root))
  form.addEventListener('submit', submitNotificationCampaign)
  renderIcons(root)
  syncDraft()
  updateNotificationRecipientVisibility(root)
  renderNotificationComposeSummary()
  if (notificationDraftIsValid()) queueNotificationPreview()
}

async function submitNotificationCampaign(event) {
  event.preventDefault()
  const draft = state.notificationCenter
  const button = document.querySelector('#notificationSendButton')
  if (!notificationDraftIsValid()) return toast('请完整填写接收范围和通知内容', 'error')
  if (!draft.preview?.token) return toast('请等待接收人估算完成后再发送', 'error')
  const recipientCount = notificationPreviewValue(draft.preview, 'recipientCount', 'recipient_count')
  const scopeLabel = notificationScopeLabels[draft.scope]
  const message = `将向${scopeLabel}发送“${draft.title.trim()}”，预计覆盖 ${recipientCount.toLocaleString('zh-CN')} 人；站内信固定开启${draft.emailEnabled ? '，并尝试投递邮件' : '，不发送邮件'}。发送后内容和范围不可编辑。`
  const confirmAllText = draft.scope === 'all' ? '发送给全部用户' : ''
  if (!await confirmAction('确认发送通知？', message, '发送通知', false, confirmAllText)) return
  if (button) button.disabled = true
  try {
    const payload = notificationDraftPayload({ includePreview:true })
    if (confirmAllText) payload.confirmAllText = confirmAllText
    draft.createIdempotencyKey ||= notificationIdempotencyKey('notification-create')
    await api('/api/admin/notifications/campaigns', { method:'POST', headers:{'Idempotency-Key':draft.createIdempotencyKey}, body:JSON.stringify(payload) })
    toast('通知已创建，正在进入发送记录', 'success')
    draft.createIdempotencyKey = ''
    draft.tab = 'records'
    draft.campaignPage = 1
    draft.selectedCampaign = null
    await renderNotificationTab()
  } catch (error) {
    if (error.status === 409 || /范围已变化|scope_changed|recipient_changed/i.test(`${error.message} ${error.code}`)) {
      if (error.data?.preview) draft.preview = error.data.preview
      draft.previewError = ''
      draft.previewNotice = '接收范围已变化，摘要已更新；请重新确认后再发送。'
      draft.previewLoading = false
      renderNotificationComposeSummary()
      toast('接收范围已变化，请重新确认', 'error')
    } else handleError(error)
  } finally {
    if (button?.isConnected) button.disabled = !notificationDraftIsValid() || !draft.preview?.token
  }
}

function notificationCampaignStatus(campaign) {
  return campaign?.status || campaign?.state || 'queued'
}

function notificationCampaignMetric(campaign, camel, snake, nestedChannel = '') {
  const direct = campaign?.[camel] ?? campaign?.[snake]
  if (direct != null) return Number(direct || 0)
  const summary = campaign?.channelSummary || campaign?.channel_summary || campaign?.channels || {}
  if (nestedChannel && summary[nestedChannel]) {
    const value = summary[nestedChannel].sent ?? summary[nestedChannel][camel] ?? summary[nestedChannel][snake]
    if (value != null) return Number(value || 0)
  }
  return 0
}

function notificationCampaignRows(campaigns) {
  if (!campaigns.length) return '<div class="empty-state notification-empty-state"><div><span class="notification-empty-icon" aria-hidden="true">◇</span><strong>还没有发送记录</strong><p>发送通知后，可在这里查看站内信、邮件以及用户阅读确认结果。</p></div></div>'
  return `<div class="table-wrap"><table class="user-table notification-campaign-table"><thead><tr><th>通知</th><th>接收范围</th><th>渠道汇总</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>${campaigns.map(campaign => { const status=notificationCampaignStatus(campaign); const recipientCount=Number(campaign.recipientCount ?? campaign.recipient_count ?? 0); const inApp=notificationCampaignMetric(campaign,'inAppSentCount','in_app_sent_count','in_app'); const emailSent=notificationCampaignMetric(campaign,'emailSentCount','email_sent_count','email'); const emailFailed=notificationCampaignMetric(campaign,'emailFailedCount','email_failed_count','email'); const emailSkipped=notificationCampaignMetric(campaign,'emailSkippedCount','email_skipped_count','email'); return `<tr data-notification-campaign-row="${escapeHtml(campaign.id)}"><td><strong>${escapeHtml(campaign.title || '未命名通知')}</strong><div class="helper">${campaign.priority === 'important' ? '重要 · 需确认' : '普通通知'}</div></td><td>${escapeHtml(notificationScopeLabels[campaign.recipientScope || campaign.recipient_scope] || '指定范围')}<div class="helper">${recipientCount.toLocaleString('zh-CN')} 人</div></td><td><span class="notification-channel-summary">站内信 ${inApp.toLocaleString('zh-CN')} · 邮件 ${emailSent.toLocaleString('zh-CN')}</span><div class="helper">跳过 ${emailSkipped.toLocaleString('zh-CN')}${emailFailed ? ` · 失败 ${emailFailed.toLocaleString('zh-CN')}` : ''}</div></td><td>${statusBadge(status, notificationCampaignStatusLabels)}</td><td class="mono">${escapeHtml(formatDate(campaign.createdAt || campaign.created_at, true))}</td><td><button class="text-button" type="button" data-notification-campaign="${escapeHtml(campaign.id)}">查看详情</button></td></tr>` }).join('')}</tbody></table></div><div class="mobile-user-list notification-mobile-list">${campaigns.map(campaign => { const status=notificationCampaignStatus(campaign); const recipientCount=Number(campaign.recipientCount ?? campaign.recipient_count ?? 0); const emailFailed=notificationCampaignMetric(campaign,'emailFailedCount','email_failed_count','email'); const emailSkipped=notificationCampaignMetric(campaign,'emailSkippedCount','email_skipped_count','email'); return `<article class="mobile-user-card notification-campaign-card"><div class="mobile-user-card-head"><div><strong>${escapeHtml(campaign.title || '未命名通知')}</strong><div class="helper">${escapeHtml(notificationScopeLabels[campaign.recipientScope || campaign.recipient_scope] || '指定范围')} · ${recipientCount.toLocaleString('zh-CN')} 人</div></div>${statusBadge(status, notificationCampaignStatusLabels)}</div><div class="mobile-user-card-meta"><span>${campaign.priority === 'important' ? '重要通知' : '普通通知'}</span><span>跳过 ${emailSkipped}${emailFailed ? ` · 失败 ${emailFailed}` : ''}</span></div><button class="secondary-button compact-action" type="button" data-notification-campaign="${escapeHtml(campaign.id)}">查看详情</button></article>` }).join('')}</div>`
}

async function loadNotificationCampaigns() {
  const root = document.querySelector('#notificationRecordsContent')
  if (!root) return
  const draft = state.notificationCenter
  root.setAttribute('aria-busy', 'true')
  try {
    const params = new URLSearchParams({ page:String(draft.campaignPage), page_size:'10', pageSize:'10' })
    const data = await api(`/api/admin/notifications/campaigns?${params}`)
    draft.campaigns = data.campaigns || []
    draft.pagination = data.pagination || { page:draft.campaignPage, total_pages:1, total:draft.campaigns.length }
    const totalPagesValue = Number(draft.pagination.totalPages ?? draft.pagination.total_pages ?? 1)
    root.innerHTML = `<div class="notification-record-list">${notificationCampaignRows(draft.campaigns)}</div><footer class="pagination notification-pagination"><button class="secondary-button" id="notificationCampaignPrev" type="button">上一页</button><span id="notificationCampaignPageLabel">第 ${Number(draft.pagination.page || draft.campaignPage)} / ${Math.max(1,totalPagesValue)} 页 · 共 ${Number(draft.pagination.total || draft.campaigns.length)} 条</span><button class="secondary-button" id="notificationCampaignNext" type="button">下一页</button></footer><section class="notification-detail" id="notificationDetail" aria-live="polite"></section>`
    const totalPages = Math.max(1, totalPagesValue)
    root.querySelector('#notificationCampaignPrev').disabled = draft.campaignPage <= 1
    root.querySelector('#notificationCampaignNext').disabled = draft.campaignPage >= totalPages
    root.querySelector('#notificationCampaignPrev').onclick = () => { draft.campaignPage -= 1; loadNotificationCampaigns().catch(handleError) }
    root.querySelector('#notificationCampaignNext').onclick = () => { draft.campaignPage += 1; loadNotificationCampaigns().catch(handleError) }
    root.querySelectorAll('[data-notification-campaign]').forEach(button => button.addEventListener('click', () => loadNotificationCampaignDetail(button.dataset.notificationCampaign).catch(handleError)))
    if (draft.selectedCampaign?.id) await loadNotificationCampaignDetail(draft.selectedCampaign.id, draft.detailPage)
  } catch (error) {
    root.innerHTML = `<div class="notification-load-error" role="alert"><strong>发送记录暂时无法读取</strong><p>${escapeHtml(error.message || '请稍后重试')}</p><button class="secondary-button" id="retryNotificationRecords" type="button">重新读取</button></div>`
    root.querySelector('#retryNotificationRecords')?.addEventListener('click', () => loadNotificationCampaigns().catch(handleError))
  } finally { root.setAttribute('aria-busy', 'false') }
}

function notificationDeliveryRows(deliveries) {
  if (!deliveries.length) return '<div class="empty-inline">暂无投递明细</div>'
  return `<div class="table-wrap"><table class="user-table notification-delivery-table"><thead><tr><th>用户</th><th>渠道</th><th>状态</th><th>尝试次数</th><th>更新时间</th><th>原因</th></tr></thead><tbody>${deliveries.map(delivery => { const status=delivery.status || delivery.deliveryStatus || 'pending'; const channel=delivery.channel === 'email' ? '邮件' : '站内信'; const label=delivery.nickname || delivery.name || `用户 #${delivery.userId ?? delivery.user_id ?? ''}`; const cause=delivery.lastError || delivery.last_error || delivery.error || ''; return `<tr><td><strong>${escapeHtml(label)}</strong><div class="helper">${escapeHtml(delivery.emailMasked || delivery.email_masked || delivery.email || '联系方式已隐藏')}</div></td><td>${channel}</td><td>${statusBadge(status, notificationDeliveryStatusLabels)}${status === 'unknown' ? '<div class="notification-unknown-warning">可能已投递</div>' : ''}</td><td class="mono">${Number(delivery.attemptCount ?? delivery.attempt_count ?? 0)}</td><td class="mono">${escapeHtml(formatDate(delivery.updatedAt || delivery.updated_at || delivery.sentAt || delivery.sent_at, true))}</td><td>${cause ? `<span class="error-helper">${escapeHtml(cause)}</span>` : '<span class="helper">—</span>'}</td></tr>` }).join('')}</tbody></table></div>`
}

function notificationDetailHtml(campaign, deliveries, pagination) {
  if (!campaign) return ''
  const status=notificationCampaignStatus(campaign)
  const unknownCount=deliveries.filter(item => item.status === 'unknown' && item.channel === 'email').length
  const needsReviewNotice=status === 'needs_review'
    ? '<div class="notification-needs-review-banner" role="alert"><strong>接收范围需要重新确认</strong><span>实际接收人数与确认值不一致，系统未开始投递；取消后按最新范围重新预览创建。</span></div>'
    : ''
  const recipientCount=Number(campaign.recipientCount ?? campaign.recipient_count ?? 0)
  const emailSent=notificationCampaignMetric(campaign,'emailSentCount','email_sent_count','email')
  const emailFailed=notificationCampaignMetric(campaign,'emailFailedCount','email_failed_count','email')
  const emailSkipped=notificationCampaignMetric(campaign,'emailSkippedCount','email_skipped_count','email')
  const detailTotalPages = Math.max(1, Number(pagination?.totalPages ?? pagination?.total_pages ?? 1))
  return `<div class="notification-detail-heading"><div><span class="eyebrow">活动详情</span><h2>${escapeHtml(campaign.title || '未命名通知')}</h2><p>${escapeHtml(notificationScopeLabels[campaign.recipientScope || campaign.recipient_scope] || '指定范围')} · 创建于 ${escapeHtml(formatDate(campaign.createdAt || campaign.created_at, true))}</p></div><div class="notification-detail-actions">${['queued','materializing','sending','cancelling','needs_review'].includes(status) ? '<button class="secondary-button danger-outline" type="button" data-notification-campaign-cancel>取消未发送任务</button>' : ''}${emailFailed ? '<button class="secondary-button" type="button" data-notification-campaign-retry>重试失败邮件</button>' : ''}</div></div>${needsReviewNotice}${unknownCount ? '<div class="notification-unknown-banner" role="note"><strong>存在状态未知的邮件</strong><span>服务商响应未确认，人工重试可能造成重复邮件，请先核对收件箱。</span></div>' : ''}<dl class="notification-detail-facts"><div><dt>预计接收</dt><dd>${recipientCount.toLocaleString('zh-CN')} 人</dd></div><div><dt>站内信已生成</dt><dd>${notificationCampaignMetric(campaign,'inAppSentCount','in_app_sent_count','in_app').toLocaleString('zh-CN')} 条</dd></div><div><dt>邮件已发送</dt><dd>${emailSent.toLocaleString('zh-CN')} 条</dd></div><div><dt>邮件跳过</dt><dd>${emailSkipped.toLocaleString('zh-CN')} 条</dd></div><div><dt>邮件失败</dt><dd>${emailFailed.toLocaleString('zh-CN')} 条</dd></div></dl><p class="notification-detail-copy"><strong>${campaign.priority === 'important' ? '重要通知 · 用户需要确认' : '普通通知'}</strong>　${escapeHtml(campaign.message || '')}</p><div class="notification-delivery-region"><h3>投递明细</h3>${notificationDeliveryRows(deliveries)}</div><footer class="pagination notification-detail-pagination"><button class="secondary-button" id="notificationDetailPrev" type="button">上一页</button><span>第 ${Number(pagination?.page || 1)} / ${detailTotalPages} 页</span><button class="secondary-button" id="notificationDetailNext" type="button">下一页</button></footer>`
}

async function loadNotificationCampaignDetail(campaignId, page = 1) {
  const root = document.querySelector('#notificationDetail')
  if (!root) return
  const draft = state.notificationCenter
  root.innerHTML = '<div class="empty-state notification-detail-loading">正在读取活动详情…</div>'
  const data = await api(`/api/admin/notifications/campaigns/${encodeURIComponent(campaignId)}?page=${Number(page)}&page_size=20&pageSize=20`)
  draft.selectedCampaign = data.campaign || { id:campaignId }
  draft.selectedCampaign.deliveries = data.deliveries || []
  draft.detailPagination = data.pagination || { page, total_pages:1 }
  draft.detailPage = Number(draft.detailPagination.page || page)
  root.innerHTML = notificationDetailHtml(draft.selectedCampaign, draft.selectedCampaign.deliveries, draft.detailPagination)
  const totalPages = Math.max(1, Number(draft.detailPagination.totalPages ?? draft.detailPagination.total_pages ?? 1))
  root.querySelector('#notificationDetailPrev').disabled = draft.detailPage <= 1
  root.querySelector('#notificationDetailNext').disabled = draft.detailPage >= totalPages
  root.querySelector('#notificationDetailPrev').onclick = () => loadNotificationCampaignDetail(campaignId, draft.detailPage - 1).catch(handleError)
  root.querySelector('#notificationDetailNext').onclick = () => loadNotificationCampaignDetail(campaignId, draft.detailPage + 1).catch(handleError)
  root.querySelector('[data-notification-campaign-cancel]')?.addEventListener('click', async event => {
    if (!await confirmAction('取消尚未发送的通知？', '已经生成的站内信和服务商已接受的邮件不会撤回，只会停止尚未取得任务的投递。', '确认取消', true)) return
    event.currentTarget.disabled = true
    try { await api(`/api/admin/notifications/campaigns/${encodeURIComponent(campaignId)}/cancel`, { method:'POST', headers:{'Idempotency-Key':notificationIdempotencyKey('notification-cancel')} }); toast('取消请求已提交', 'success'); await loadNotificationCampaigns() } catch (error) { handleError(error); event.currentTarget.disabled = false }
  })
  root.querySelector('[data-notification-campaign-retry]')?.addEventListener('click', async event => {
    const unknown = draft.selectedCampaign.deliveries?.some(item => item.channel === 'email' && item.status === 'unknown')
    const warning = unknown ? '其中有状态未知的邮件，服务商可能已经接受；人工重试可能造成重复邮件。' : '仅会重新尝试仍处于失败状态的邮件。'
    if (!await confirmAction('重试失败邮件？', warning, '确认重试', unknown)) return
    event.currentTarget.disabled = true
    try { await api(`/api/admin/notifications/campaigns/${encodeURIComponent(campaignId)}/retry-failed-email`, { method:'POST', headers:{'Idempotency-Key':notificationIdempotencyKey('notification-email-retry')} }); toast('失败邮件已进入重试队列', 'success'); await loadNotificationCampaignDetail(campaignId, draft.detailPage); await loadNotificationCampaigns() } catch (error) { handleError(error); event.currentTarget.disabled = false }
  })
}

async function renderNotificationRecords(root) {
  root.innerHTML = '<section class="panel notification-record-panel" id="notificationRecordsContent" aria-busy="true"><div class="empty-state">正在读取发送记录…</div></section>'
  await loadNotificationCampaigns()
}

async function renderNotificationTab() {
  const root = document.querySelector('#notificationCenterContent')
  if (!root) return
  const draft = state.notificationCenter
  document.querySelectorAll('[data-notification-center-tab]').forEach(button => { const active=button.dataset.notificationCenterTab===draft.tab; button.classList.toggle('is-active', active); button.setAttribute('aria-selected',String(active)) })
  if (draft.tab === 'records') await renderNotificationRecords(root)
  else { root.innerHTML = notificationComposeMarkup(); bindNotificationCompose(root) }
}

async function renderNotificationCenterPage() {
  const main = document.querySelector('#adminMain')
  main.innerHTML = `<header class="page-head notification-center-head"><div><span class="eyebrow">用户触达与审计</span><h1>通知中心</h1><p>编辑通知、预估接收范围，并跟踪站内信和邮件的实际投递结果。</p></div></header><nav class="segment-tabs notification-center-tabs" aria-label="通知中心分类"><button class="segment-tab" type="button" role="tab" aria-selected="false" data-notification-center-tab="compose">发送通知</button><button class="segment-tab" type="button" role="tab" aria-selected="false" data-notification-center-tab="records">发送记录</button></nav><div id="notificationCenterContent" role="tabpanel" aria-live="polite"></div>`
  document.querySelectorAll('[data-notification-center-tab]').forEach(button => button.addEventListener('click', async () => { const next=button.dataset.notificationCenterTab; if (next===state.notificationCenter.tab) return; state.notificationCenter.tab=next; state.notificationCenter.selectedCampaign=null; await renderNotificationTab() }))
  await renderNotificationTab()
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
function formatAdminDateInput(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
function adminMembershipExpiryPreset(preset) {
  if (preset === 'long_term') return ''
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  if (preset === 'half_month') date.setDate(date.getDate() + 15)
  else {
    const months = { one_month:1, three_months:3, one_year:12 }[preset]
    if (!months) return null
    const originalDay = date.getDate()
    date.setDate(1)
    date.setMonth(date.getMonth() + months)
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    date.setDate(Math.min(originalDay, lastDay))
  }
  return formatAdminDateInput(date)
}
function bindMembershipExpiryPresets(body, initialPlan) {
  const plan = body.querySelector('#profilePlan')
  const expiry = body.querySelector('#profileExpiry')
  const buttons = [...body.querySelectorAll('[data-expiry-preset]')]
  const helper = body.querySelector('#profileExpiryHelper')
  const planState = body.querySelector('#profileMembershipPlanState')
  const expiryState = body.querySelector('#profileMembershipExpiryState')
  const updateSummary = () => {
    const labels = { free:'免费用户', plus:'Plus 会员', pro:'Pro 专业版' }
    if (planState) {
      planState.textContent = labels[plan.value] || '未知等级'
      planState.dataset.plan = plan.value
    }
    if (expiryState) {
      expiryState.textContent = plan.value === 'free'
        ? '无需设置到期日期'
        : expiry.value
          ? `有效至 ${new Date(`${expiry.value}T12:00:00`).toLocaleDateString('zh-CN')}`
          : '长期有效'
    }
  }
  const setEnabled = value => {
    const disabled = value === 'free'
    expiry.disabled = disabled
    buttons.forEach(button => { button.disabled = disabled })
    if (disabled) {
      buttons.forEach(button => button.setAttribute('aria-pressed', 'false'))
      helper.textContent = '免费用户无需设置到期日期。'
    } else if (helper.textContent === '免费用户无需设置到期日期。') {
      helper.textContent = '快捷期限从今天开始计算；也可以手动选择日期。'
    }
    updateSummary()
  }
  const clearSelection = () => buttons.forEach(button => button.setAttribute('aria-pressed', 'false'))
  buttons.forEach(button => button.addEventListener('click', () => {
    const value = adminMembershipExpiryPreset(button.dataset.expiryPreset)
    if (value === null) return
    expiry.value = value
    clearSelection()
    button.setAttribute('aria-pressed', 'true')
    helper.textContent = value
      ? `已设置为 ${new Date(`${value}T12:00:00`).toLocaleDateString('zh-CN')} 到期，保存后生效。`
      : '已设置为长期有效（无到期日期），保存后生效。'
    updateSummary()
  }))
  expiry.addEventListener('input', () => {
    clearSelection()
    helper.textContent = expiry.value
      ? `已手动选择 ${new Date(`${expiry.value}T12:00:00`).toLocaleDateString('zh-CN')}，保存后生效。`
      : '未设置到期日期，将按长期有效保存。'
    updateSummary()
  })
  plan.addEventListener('change', event => setEnabled(event.target.value))
  setEnabled(initialPlan)
}
function renderUserDetail(tab) {
  const { user, runtime, accounts, subscriptions } = state.selectedUser
  const displayName = user.nickname || user.email || user.phone || `用户 #${user.id}`
  document.querySelector('#userModalTitle').textContent = displayName
  document.querySelector('#userModalAvatar').textContent = displayName.slice(0,1)
  document.querySelector('#userModalMembership').innerHTML = membershipBadge(user)
  document.querySelector('#userModalMeta').innerHTML = `<span>${icons.mail}${escapeHtml(user.email || '未绑定邮箱')}</span><span>${icons.phone}${escapeHtml(user.phone || '未绑定手机号')}</span><span class="mono">UID ${escapeHtml(user.uid)}</span>`
  const body = document.querySelector('#userModalBody')
  const tabs = `<div class="detail-tabs" role="tablist" aria-label="用户档案分类"><button class="detail-tab ${tab === 'profile' ? 'is-active' : ''}" data-detail-tab="profile" type="button" role="tab" aria-selected="${tab === 'profile'}">${icons.users}<span>运营档案</span></button><button class="detail-tab ${tab === 'trading' ? 'is-active' : ''}" data-detail-tab="trading" type="button" role="tab" aria-selected="${tab === 'trading'}">${icons.chart}<span>交易接入</span></button><button class="detail-tab ${tab === 'operations' ? 'is-active' : ''}" data-detail-tab="operations" type="button" role="tab" aria-selected="${tab === 'operations'}">${icons.shield}<span>运行与风控</span></button></div>`
  if (tab === 'operations') {
    if(state.selectedUser.operations){body.innerHTML=`${tabs}${userOperationsMarkup(state.selectedUser.operations)}`;bindUserOperations(user.id)}
    else{body.innerHTML=`${tabs}<div class="empty-state">正在读取运行与风控数据…</div>`;loadSelectedUserOperations(user.id).then(()=>renderUserDetail('operations')).catch(error=>{handleError(error);renderUserDetail('trading')})}
  } else if (tab === 'trading') {
    body.innerHTML = `${tabs}<div class="summary-grid"><div class="summary-item"><span>自动分析</span><strong>${runtime.auto_reasoning_enabled ? '已开启' : '已关闭'}</strong></div><div class="summary-item"><span>交易发送</span><strong>${runtime.trade_send_enabled ? '已开启' : '已关闭'}</strong></div><div class="summary-item"><span>订阅策略</span><strong>${subscriptions.length} 条</strong></div></div><h3 style="margin-top:22px">MT5 账户</h3><div class="module-list">${accounts.length ? accounts.map(account => `<div class="module-row"><span class="module-icon">${icons.chart}</span><div><strong>${escapeHtml(account.mt5_login || '未知账号')} · ${escapeHtml(account.broker_server || '未知服务器')}</strong><small>${escapeHtml(account.nickname || '未设置账户名称')} · ${escapeHtml(account.observe_status || '状态未知')}</small></div></div>`).join('') : '<div class="notice">该用户尚未接入 MT5 账户。</div>'}</div>`
  } else {
    const expiry = String(user.plan_expires_at || '').slice(0,10)
    body.innerHTML = `${tabs}<form class="profile-workspace" id="profileForm"><div class="profile-layout"><section class="profile-section profile-identity-section" aria-labelledby="profileIdentityTitle"><header class="profile-section-head"><span class="profile-section-icon">${icons.users}</span><div><h3 id="profileIdentityTitle">身份资料</h3><p>维护用户展示信息、联系方式与后台权限。</p></div></header><div class="profile-section-grid"><div class="field"><label for="profileNickname">用户昵称</label><input class="input" id="profileNickname" name="nickname" autocomplete="nickname" value="${escapeHtml(user.nickname)}" placeholder="请输入用户昵称"></div><div class="field"><label for="profileRole">账号角色</label><select class="select" id="profileRole" name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></div><div class="field"><label for="profileEmail">邮箱（可选）</label><input class="input" id="profileEmail" name="email" type="email" autocomplete="email" value="${escapeHtml(user.email)}" placeholder="未绑定邮箱"></div><div class="field"><label for="profilePhone">手机号（可选）</label><input class="input" id="profilePhone" name="phone" type="tel" autocomplete="tel" value="${escapeHtml(user.phone)}" placeholder="未绑定手机号"></div></div><div class="profile-section-note">${icons.info}<span>邮箱与手机号可以任意留空；已有联系方式的账号至少保留一项。</span></div></section><section class="profile-section profile-membership-section" aria-labelledby="profileMembershipTitle"><header class="profile-section-head"><span class="profile-section-icon">${icons.wallet}</span><div><h3 id="profileMembershipTitle">会员权益</h3><p>调整等级与有效期，保存后立即生效。</p></div></header><div class="profile-membership-summary" aria-live="polite"><div><span>当前选择</span><strong id="profileMembershipPlanState" data-plan="${escapeHtml(user.plan)}">${escapeHtml(planDisplayLabels[user.plan] || user.plan || '免费用户')}</strong></div><div><span>有效期限</span><strong id="profileMembershipExpiryState">${user.plan === 'free' ? '无需设置到期日期' : expiry ? `有效至 ${escapeHtml(new Date(`${expiry}T12:00:00`).toLocaleDateString('zh-CN'))}` : '长期有效'}</strong></div></div><div class="profile-membership-fields"><div class="field"><label for="profilePlan">会员等级</label><select class="select" id="profilePlan" name="plan"><option value="free">免费用户</option><option value="plus">Plus 会员</option><option value="pro">Pro 专业版</option></select></div><div class="field membership-expiry-field"><label for="profileExpiry">到期日期</label><input class="input" id="profileExpiry" name="expires_at" type="date" value="${escapeHtml(expiry)}"><div class="membership-expiry-presets" role="group" aria-label="快捷设置会员有效期"><button type="button" data-expiry-preset="half_month" aria-pressed="false">半个月</button><button type="button" data-expiry-preset="one_month" aria-pressed="false">一个月</button><button type="button" data-expiry-preset="three_months" aria-pressed="false">3个月</button><button type="button" data-expiry-preset="one_year" aria-pressed="false">一年</button><button type="button" data-expiry-preset="long_term" aria-pressed="false">长期有效</button></div><span class="helper" id="profileExpiryHelper" aria-live="polite">快捷期限从今天开始计算；也可以手动选择日期。</span></div></div></section><section class="profile-section profile-security-section" aria-labelledby="profileSecurityTitle"><header class="profile-section-head"><span class="profile-section-icon">${icons.key}</span><div><h3 id="profileSecurityTitle">账号安全</h3><p>仅在需要时重置密码，留空不会修改现有密码。</p></div></header><div class="field"><label for="profilePassword">设置新密码（可选）</label><input class="input" id="profilePassword" name="password" type="password" autocomplete="new-password" placeholder="至少 8 位，必须包含字母和数字"><span class="helper">保存新密码后，该用户的桥接长期登录会话会立即失效。</span></div></section></div><div class="profile-form-actions">${user.role!=='admin'?'<button class="secondary-button" id="sendUserNotificationButton" type="button">发送通知</button>':''}${user.role!=='admin'?'<button class="text-button danger-text" id="deleteUserButton" type="button">匿名化删除账号</button>':''}<div class="profile-save-note">${icons.info}<span>所有修改仅在保存后生效</span></div><span class="action-spacer"></span><button class="secondary-button" type="button" data-close-modal>取消</button><button class="primary-button" id="saveProfileButton" type="submit">${icons.save}<span>保存档案</span></button></div></form>`
    body.querySelector('#profileRole').value = user.role
    body.querySelector('#profilePlan').value = user.plan
    bindMembershipExpiryPresets(body, user.plan)
    body.querySelector('#profileForm').addEventListener('submit', saveUserProfile)
    body.querySelector('#deleteUserButton')?.addEventListener('click',deleteSelectedUser)
    body.querySelector('#sendUserNotificationButton')?.addEventListener('click', () => openNotificationCenterForUser(user))
    body.querySelector('[data-close-modal]').addEventListener('click', closeUserModal)
  }
  body.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => renderUserDetail(button.dataset.detailTab)))
}
async function deleteSelectedUser(){
  const user=state.selectedUser?.user;if(!user||user.role==='admin')return
  if(!await confirmAction('匿名化删除用户账号？','登录凭证、个人资料、个人模型和运行配置会被销毁；订单、交易、风控及审计证据会依法保留。该操作无法恢复。','确认永久删除',true,user.email))return
  const button=document.querySelector('#deleteUserButton');button.disabled=true
  try{await api(`/api/admin/users/${user.id}`,{method:'DELETE',body:JSON.stringify({confirm_email:user.email})});toast('用户账号已匿名化删除','success');closeUserModal();await loadUsers()}catch(error){handleError(error);button.disabled=false}
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
function openNotificationCenterForUser(user) {
  if (!user?.id) return
  const draft = state.notificationCenter
  draft.tab = 'compose'
  draft.scope = 'user'
  draft.userId = String(user.id)
  draft.userLabel = `${user.nickname || user.email || `用户 #${user.id}`} · ${user.email || user.phone || '联系方式未显示'}`
  draft.userSearch = draft.userLabel
  draft.plans = []
  draft.preview = null
  draft.previewError = ''
  draft.previewNotice = ''
  closeUserModal()
  setView('notifications').then(() => document.querySelector('#notificationTitle')?.focus()).catch(handleError)
}
function confirmAction(title, message, confirmLabel = '确认', danger = false, requiredText = '') {
  const layer = document.querySelector('#confirmModal')
  const button = document.querySelector('#confirmModalButton')
  document.querySelector('#confirmModalTitle').textContent = title
  document.querySelector('#confirmModalMessage').textContent = message
  button.textContent = confirmLabel
  button.classList.toggle('danger-button', danger)
  const requiredField=document.querySelector('#confirmRequiredField'),requiredInput=document.querySelector('#confirmRequiredInput'),requiredLabel=document.querySelector('#confirmRequiredLabel')
  requiredField.hidden=!requiredText;requiredInput.value='';requiredLabel.textContent=requiredText?`请输入“${requiredText}”以确认`:'请输入确认内容';button.disabled=Boolean(requiredText)
  const validateRequired=()=>{button.disabled=Boolean(requiredText)&&requiredInput.value.trim()!==requiredText}
  requiredInput.addEventListener('input',validateRequired)
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
      requiredInput.removeEventListener('input',validateRequired)
      layer.querySelectorAll('[data-cancel-confirm]').forEach(item => item.removeEventListener('click', cancel))
      resolve(value)
    }
    const accept = () => finish(true)
    const cancel = () => finish(false)
    button.addEventListener('click', accept)
    layer.querySelectorAll('[data-cancel-confirm]').forEach(item => item.addEventListener('click', cancel))
    if(requiredText)requiredInput.focus();else button.focus()
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
  return `<nav class="ai-ops-nav" role="tablist" aria-label="AI 运营模块">
    <button type="button" role="tab" aria-selected="${state.aiTab === 'health'}" class="segment-tab ai-ops-tab ${state.aiTab === 'health' ? 'is-active' : ''}" data-ai-tab="health"><span data-icon="activity" aria-hidden="true"></span><span>运行总览</span></button>
    <button type="button" role="tab" aria-selected="${state.aiTab === 'scheduler'}" class="segment-tab ai-ops-tab ${state.aiTab === 'scheduler' ? 'is-active' : ''}" data-ai-tab="scheduler"><span data-icon="chart" aria-hidden="true"></span><span>调度监控</span></button>
    <button type="button" role="tab" aria-selected="${state.aiTab === 'observer'}" class="segment-tab ai-ops-tab ${state.aiTab === 'observer' ? 'is-active' : ''}" data-ai-tab="observer"><span data-icon="users" aria-hidden="true"></span><span>观摩频道</span></button>
    <button type="button" role="tab" aria-selected="${state.aiTab === 'memory'}" class="segment-tab ai-ops-tab ${state.aiTab === 'memory' ? 'is-active' : ''}" data-ai-tab="memory"><span data-icon="activity" aria-hidden="true"></span><span>统一记忆</span></button>
    <button type="button" role="tab" aria-selected="${state.aiTab === 'model-compare'}" class="segment-tab ai-ops-tab ${state.aiTab === 'model-compare' ? 'is-active' : ''}" data-ai-tab="model-compare"><span data-icon="chart" aria-hidden="true"></span><span>模型评测</span></button>
    <button type="button" role="tab" aria-selected="${state.aiTab === 'governance'}" class="segment-tab ai-ops-tab ${state.aiTab === 'governance' ? 'is-active' : ''}" data-ai-tab="governance"><span data-icon="settings" aria-hidden="true"></span><span>平台治理</span></button>
  </nav>`
}
function syncAiTabs() {
  document.querySelectorAll('[data-ai-tab]').forEach(button => {
    const active = button.dataset.aiTab === state.aiTab
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', String(active))
  })
}
function bindAiTabs() {
  document.querySelectorAll('[data-ai-tab]').forEach(button => button.addEventListener('click', () => {
    if (state.aiTab === 'memory' && button.dataset.aiTab !== 'memory') { pausePlatformMemoryCompressionPolling(); stopPlatformMemoryConsistencyPolling() }
    state.aiTab = button.dataset.aiTab
    renderAiOperationsContent()
    if (state.aiTab === 'memory' && state.platformMemory) loadPlatformMemory().catch(handleError)
  }))
}
function bindAiJumpActions(root = document) {
  root.querySelectorAll('[data-ai-jump]').forEach(button => button.addEventListener('click', () => {
    state.aiTab = button.dataset.aiJump
    renderAiOperationsContent()
  }))
}
function aiHealthContent(data) {
  const summary = data.summary || {}
  const health = data.health || { state:'insufficient_data', reasons:[], components:{}, freshness:{} }
  const requests = Number(summary.model_requests_today || 0)
  const failures = Number(summary.model_failures_today || 0)
  const alerts = Array.isArray(data.rollout?.alerts) ? data.rollout.alerts : []
  const pendingReviews = (data.review_health?.cases || []).filter(item => ['draft','edited','ready','generating'].includes(item.status)).reduce((sum, item) => sum + Number(item.case_count || 0), 0)
  const failedReviews = (data.review_health?.cases || []).filter(item => item.status === 'failed').reduce((sum, item) => sum + Number(item.case_count || 0), 0)
  const healthStates = {
    healthy:{ label:'运行正常', title:'AI 核心链路运行正常', copy:'有明确运行预期的链路均有可用证据，未发现阻断性异常。', tone:'is-healthy' },
    attention:{ label:'需要关注', title:'AI 核心链路需要关注', copy:'已有运行证据显示部分链路异常，请按原因优先处理。', tone:'needs-attention' },
    critical:{ label:'严重异常', title:'AI 核心链路存在严重异常', copy:'关键链路已失效或权威数据源不可用，需要立即处理。', tone:'is-critical' },
    insufficient_data:{ label:'数据不足', title:'当前无法确认 AI 链路健康', copy:'没有足够的运行预期或样本，页面不会把零请求判定为正常。', tone:'is-unknown' },
  }
  const healthMeta = healthStates[health.state] || healthStates.insufficient_data
  const successRate = requests > 0 ? Math.max(0, (requests - failures) / requests * 100) : null
  const latencySeconds = Number(summary.avg_model_latency_ms || 0) / 1000
  const signalErrors = Number(summary.signal_errors_today || 0)
  const signalCount = Number(summary.signals_today || 0)
  const connectedBridges = Number(summary.connected_bridges || 0)
  const connectedMt4Bridges = Number(summary.connected_mt4_bridges || 0)
  const connectedMt5Bridges = Number(summary.connected_mt5_bridges || 0)
  const queueCount = alerts.length + pendingReviews + failedReviews
  const terminalTime = formatTerminalTime(state.realtime.terminalTime)
  const terminalLabel = terminalPlatformLabel()
  const reasonLabels = {
    scheduler_runtime_unavailable:'自动分析已配置，但实时调度状态不可用', signal_errors_24h:'过去 24 小时出现异常信号',
    observer_source_unavailable:'启用中的观摩频道失去权威数据源', review_jobs_failed:'周期复盘存在失败任务',
    memory_compression_stale:'统一记忆库压缩任务积压', uncertain_order_age:'存在长期未确认订单',
    model_requests_failed:'模型请求出现失败', governance_alert:'AI 治理规则触发告警',
  }
  const componentLabels={manual:'手动分析',model_compare:'模型评测',auto_inference:'自动分析',review:'周期复盘',memory:'统一记忆库',observer_delivery:'观摩交付'}
  const componentStates={healthy:'正常',attention:'关注',critical:'严重',insufficient_data:'数据不足'}
  const reasons=(Array.isArray(health.reasons)?health.reasons:[]).slice(0,3)
  const componentRows=Object.entries(health.components||{}).map(([key,item])=>`<div><span class="provider-dot health-${escapeHtml(item.state||'insufficient_data')}"></span><div><strong>${componentLabels[key]||'未登记链路'}</strong><small>${item.expected?'当前有运行预期':'当前无运行预期'} · 样本 ${Number(item.sample_count||0)}</small></div><b>${componentStates[item.state]||'数据不足'}</b></div>`).join('')
  return `<section class="ai-command-status ${healthMeta.tone}">
      <div class="ai-command-signal"><span data-icon="activity" aria-hidden="true"></span></div>
      <div class="ai-command-copy"><span class="eyebrow">过去 24 小时运行结论 · ${healthMeta.label}</span><h2>${healthMeta.title}</h2><p>${healthMeta.copy}</p>${reasons.length?`<ul class="ai-health-reasons">${reasons.map(item=>`<li>${escapeHtml(reasonLabels[item.code]||'检测到未分类运行异常')}（${Number(item.value||0)}）</li>`).join('')}</ul>`:''}</div>
      <div class="ai-command-meta"><span><span data-terminal-platform-label>${terminalLabel}</span> 时间 <strong>${terminalTime}</strong></span><span>评估样本 <strong>${Number(health.sample_count||0)}</strong></span></div>
      <button class="secondary-button" type="button" data-ai-jump="scheduler">查看调度</button>
    </section>
    <section class="ai-kpi-grid" aria-label="今日 AI 核心指标">
      <article class="ai-kpi-card ${successRate===null?'is-unknown':successRate >= 98 ? 'is-good' : successRate >= 95 ? 'is-watch' : 'is-critical'}"><div class="ai-kpi-head"><span>今日模型成功率</span><em>${requests?failures?`${failures} 次失败`:'稳定':'无样本'}</em></div><strong>${successRate===null?'--':`${successRate.toFixed(1)}%`}</strong><small>${requests.toLocaleString('zh-CN')} 次模型请求</small><div class="ai-kpi-track"><span style="width:${successRate===null?0:Math.max(4,Math.min(100,successRate))}%"></span></div></article>
      <article class="ai-kpi-card ${requests===0?'is-unknown':latencySeconds > 30 ? 'is-watch' : 'is-good'}"><div class="ai-kpi-head"><span>平均响应</span><em>${requests===0?'无样本':latencySeconds > 30 ? '需关注' : '正常'}</em></div><strong>${summary.avg_model_latency_ms ? `${latencySeconds.toFixed(1)} 秒` : '--'}</strong><small>仅统计成功请求</small><div class="ai-kpi-track"><span style="width:${latencySeconds ? Math.max(8,Math.min(100,latencySeconds / 60 * 100)) : 0}%"></span></div></article>
      <article class="ai-kpi-card ${signalCount===0?'is-unknown':signalErrors ? 'is-critical' : 'is-good'}"><div class="ai-kpi-head"><span>推理信号</span><em>${signalCount===0?'今日无样本':signalErrors ? `${signalErrors} 条异常` : '零异常'}</em></div><strong>${signalCount.toLocaleString('zh-CN')}</strong><small>今日已生成信号</small><div class="ai-kpi-track"><span style="width:${signalCount===0?0:signalErrors ? 54 : 100}%"></span></div></article>
      <article class="ai-kpi-card ${health.components?.observer_delivery?.expected?(connectedBridges?'is-good':'is-critical'):'is-unknown'}"><div class="ai-kpi-head"><span>在线桥接</span><em>${health.components?.observer_delivery?.expected?(connectedBridges?'实时在线':'预期连接离线'):'当前无连接预期'}</em></div><strong>${connectedBridges}</strong><small>MT4 ${connectedMt4Bridges} · MT5 ${connectedMt5Bridges}</small><div class="ai-kpi-track"><span style="width:${connectedBridges?100:0}%"></span></div></article>
    </section>
    <section class="ai-overview-grid">
      <article class="panel ai-action-queue"><header class="section-head"><div><span class="eyebrow">治理队列</span><h2>需要处理</h2><p>只列出需要人工关注或继续跟进的事项。</p></div><span class="badge ${queueCount ? 'expired' : 'active'}">${queueCount} 项</span></header><div class="ai-action-list">
        ${alerts.length ? alerts.map(item => { const memoryAlert = item.code === 'memory_compression_stale'; return `<article class="ai-action-row is-critical"><span class="ai-action-indicator"></span><div><strong>${item.code === 'uncertain_order_age' ? '存在长期未确认订单' : item.code === 'review_jobs_failed' ? '复盘任务生成失败' : memoryAlert ? '记忆压缩任务积压' : 'AI 治理任务异常'}</strong><small>${item.severity === 'critical' ? '紧急处理' : '需要关注'} · 当前值 ${Number(item.value || 0)}</small></div><button class="text-button" type="button" data-ai-jump="scheduler">查看运行态</button></article>` }).join('') : '<div class="ai-queue-empty"><span data-icon="shield" aria-hidden="true"></span><div><strong>当前没有治理告警</strong><small>异常出现后会通过 WSS 实时推送到此处。</small></div></div>'}
        <article class="ai-action-row ${failedReviews ? 'is-critical' : ''}"><span class="ai-action-indicator"></span><div><strong>周期复盘队列</strong><small>${pendingReviews} 条待处理 · ${failedReviews} 条失败</small></div><a class="text-button" href="/ai/">AI 实验室处理</a></article>
        <article class="ai-action-row"><span class="ai-action-indicator"></span><div><strong>风控正常拒绝</strong><small>今日 ${Number(summary.risk_rejections_today || 0)} 次，不计入系统故障</small></div><button class="text-button" type="button" data-ai-jump="scheduler">详情</button></article>
      </div></article>
      <article class="panel ai-chain-panel"><header class="section-head"><div><span class="eyebrow">链路状态</span><h2>运行组成</h2><p>基于运行预期、24 小时样本与权威数据源逐项评估。</p></div></header><div class="ai-chain-list">${componentRows||'<div class="empty-state compact-empty">暂无可评估链路</div>'}</div></article>
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
    const progress = Math.max(0, Math.min(100, Number(item.progress_percent || 0)))
    const detail = item.in_flight ? (item.stage_label || '正在执行分析任务') : reason
    const nextRunSeconds = schedulerRemainingSeconds(item)
    return `<article class="runtime-card ${item.in_flight ? 'is-running' : ''}" data-scheduler-key="${escapeHtml(item.key || `${item.strategy_id}:${item.symbol}`)}"><header><div><strong>${escapeHtml(item.strategy_name || `策略 #${item.strategy_id}`)}</strong><small>${escapeHtml(item.symbol || '--')} · 每 ${Number(item.interval_minutes || 5)} 分钟</small></div><span class="badge ${tone}">${stateText}</span></header><div class="runtime-facts"><span>订阅用户<strong>${Number(item.subscriber_count || 0)}</strong></span><span>下次运行<strong data-next-run>${nextRunSeconds > 0 ? `${nextRunSeconds} 秒` : '--'}</strong></span></div>${item.in_flight ? `<div class="scheduler-progress" aria-label="分析进度 ${progress}%"><span style="width:${Math.max(3,progress)}%"></span></div>` : ''}<p>${escapeHtml(detail)}</p></article>`
  })
  configured.filter(item => !runtimeIds.has(Number(item.strategy_id))).forEach(item => cards.push(`<article class="runtime-card"><header><div><strong>${escapeHtml(item.strategy_name || `策略 #${item.strategy_id}`)}</strong><small>每 ${Number(item.interval_minutes || 5)} 分钟</small></div><span class="badge">等待实例</span></header><div class="runtime-facts"><span>订阅用户<strong>${Number(item.subscriber_count || 0)}</strong></span><span>运行实例<strong>未启动</strong></span></div><p>等待桥接或调度条件满足</p></article>`))
  return `<div class="runtime-grid">${cards.join('')}</div>`
}

function stopAiSchedulerTicker() {
  if (state.realtime.schedulerTimer) clearInterval(state.realtime.schedulerTimer)
  state.realtime.schedulerTimer = null
  if (state.realtime.schedulerSyncTimer) clearInterval(state.realtime.schedulerSyncTimer)
  state.realtime.schedulerSyncTimer = null
}
function startAiSchedulerTicker() {
  stopAiSchedulerTicker()
  state.realtime.schedulerTimer = setInterval(() => {
    if (state.view !== 'ai-operations' || state.aiTab !== 'scheduler') return stopAiSchedulerTicker()
    const runtime = state.aiOperations?.scheduler?.runtime || []
    runtime.forEach(item => {
      const card = document.querySelector(`[data-scheduler-key="${CSS.escape(String(item.key || `${item.strategy_id}:${item.symbol}`))}"]`)
      const node = card?.querySelector('[data-next-run]')
      const remaining = schedulerRemainingSeconds(item)
      if (node) node.textContent = remaining > 0 ? `${remaining} 秒` : '--'
    })
  }, 1000)
  state.realtime.schedulerSyncTimer = setInterval(calibrateSchedulerRuntimeSilently, 20_000)
}
function aiSchedulerContent(data) {
  const rows = data.model_usage || []
  const runtime = data.scheduler?.runtime || []
  const configured = data.scheduler?.configured || []
  const active = runtime.filter(item => item.in_flight).length
  const waiting = runtime.filter(item => !item.in_flight && (item.running || item.wait_reason) && !item.last_error).length + configured.filter(item => !runtime.some(runtimeItem => Number(runtimeItem.strategy_id) === Number(item.strategy_id))).length
  const errors = runtime.filter(item => item.last_error).length
  const requests = rows.reduce((sum, row) => sum + Number(row.requests || 0), 0)
  const failures = rows.reduce((sum, row) => sum + Number(row.failures || 0), 0)
  return `<section class="ai-runtime-strip" aria-label="调度运行摘要">
      <div><span class="provider-dot ${data.scheduler?.runtime_available ? 'ok' : ''}"></span><p><small>数据通道</small><strong>${data.scheduler?.runtime_available ? '实时运行态' : '数据库降级态'}</strong></p></div>
      <div><small>正在推理</small><strong>${active}</strong><span>个策略实例</span></div>
      <div><small>等待条件</small><strong>${waiting}</strong><span>个待执行实例</span></div>
      <div class="${errors ? 'has-error' : ''}"><small>调度异常</small><strong>${errors}</strong><span>${errors ? '需要处理' : '当前正常'}</span></div>
      <div><small>24h 模型质量</small><strong>${percent(requests - failures, requests)}</strong><span>${requests} 次调用</span></div>
    </section>
    <section class="panel"><header class="section-head"><div><span class="eyebrow">运行实例</span><h2>自动分析调度</h2><p>${data.scheduler?.runtime_available ? '显示实时调度状态、下一次运行时间与等待原因。' : '实时缓存暂不可用，当前显示数据库配置。'}</p></div><span class="badge ${data.scheduler?.runtime_available ? 'active' : 'expired'}">${data.scheduler?.runtime_available ? 'WSS 实时数据' : '降级数据'}</span></header>${schedulerCards(data)}</section>
    <section class="panel section-gap"><header class="section-head"><div><h2>模型调用质量</h2><p>最近 24 小时按模型统计成功率、耗时和消耗。</p></div></header>
      ${rows.length ? `<div class="table-wrap"><table class="user-table business-table"><thead><tr><th>模型</th><th>调用</th><th>成功率</th><th>平均响应</th><th>令牌消耗</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.model_name || '未命名模型')}</strong><div class="helper">${escapeHtml(row.credential_source || '未知来源')}</div></td><td class="mono">${row.requests}</td><td>${percent(row.requests - row.failures, row.requests)}</td><td>${row.avg_latency_ms ? `${(row.avg_latency_ms / 1000).toFixed(1)} 秒` : '--'}</td><td class="mono">${Number(row.tokens || 0).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table></div><div class="mobile-user-list">${rows.map(row => `<article class="mobile-user-card"><div class="mobile-user-card-head"><strong>${escapeHtml(row.model_name || '未命名模型')}</strong><span class="badge ${row.failures ? 'expired' : 'active'}">${percent(row.requests - row.failures, row.requests)}</span></div><div class="mobile-business-grid"><span>调用<strong>${row.requests}</strong></span><span>平均响应<strong>${row.avg_latency_ms ? `${(row.avg_latency_ms / 1000).toFixed(1)} 秒` : '--'}</strong></span><span>令牌<strong>${Number(row.tokens || 0).toLocaleString('zh-CN')}</strong></span></div></article>`).join('')}</div>` : '<div class="empty-state">最近 24 小时没有模型调用记录</div>'}
    </section>`
}

function safeJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
const strategyEntryLabels={market:'市价入场',limit:'限价挂单',stop:'突破挂单',stop_limit:'突破限价'}
const strategyVisibilityLabels={active:'已上线',draft:'草稿',archived:'已归档'}
const strategyTimeframes=['M1','M5','M15','M30','H1','H4','D1']
const ADMIN_STRATEGY_CHAN_TIMEFRAMES=['M5','M15','H1','H4']
const ADMIN_STRATEGY_CAPABILITY_FALLBACK={version:'local-fallback',timeframes:strategyTimeframes,chan:{supported_timeframes:ADMIN_STRATEGY_CHAN_TIMEFRAMES},indicators:{ema34:{kind:'ema',period:34,field:'close',bar_scope:'closed_only',warmup_target_bars:60,evidence_window:5}},user_copy:{chan:'为已选的支持周期计算并提供原始结构。不会自动决定方向，也不会强制观望或交易。',ema34:'按所选周期的已收盘 K 线计算并提供。不会自动作为开仓过滤条件。'}}
function normalizedAdminStrategyCapabilities(value={}){const source=value?.capabilities&&typeof value.capabilities==='object'?value.capabilities:value;const chan=source?.chan&&typeof source.chan==='object'?source.chan:{};const indicators=source?.indicators&&typeof source.indicators==='object'?source.indicators:{};return {...ADMIN_STRATEGY_CAPABILITY_FALLBACK,...source,version:String(source?.version||source?.catalog_version||ADMIN_STRATEGY_CAPABILITY_FALLBACK.version),timeframes:Array.isArray(source?.timeframes)&&source.timeframes.length?source.timeframes.map(item=>String(item?.timeframe||item||'').toUpperCase()).filter(Boolean):strategyTimeframes,chan:{...ADMIN_STRATEGY_CAPABILITY_FALLBACK.chan,...chan,supported_timeframes:Array.isArray(chan.supported_timeframes)?chan.supported_timeframes.map(item=>String(item).toUpperCase()):ADMIN_STRATEGY_CHAN_TIMEFRAMES},indicators:{...ADMIN_STRATEGY_CAPABILITY_FALLBACK.indicators,...indicators,ema34:{...ADMIN_STRATEGY_CAPABILITY_FALLBACK.indicators.ema34,...(indicators.ema34||{})}},user_copy:{...ADMIN_STRATEGY_CAPABILITY_FALLBACK.user_copy,...(source?.user_copy||{})}}}
async function loadAdminStrategyDataCapabilities({force=false}={}){if(!force&&state.strategyDataCapabilitiesStatus==='ready'&&state.strategyDataCapabilities)return state.strategyDataCapabilities;if(!force&&state.strategyDataCapabilitiesStatus==='loading'&&state.strategyDataCapabilitiesRequest)return state.strategyDataCapabilitiesRequest;state.strategyDataCapabilitiesStatus='loading';const request=api('/api/ai/strategy-data-capabilities').then(data=>{state.strategyDataCapabilities=normalizedAdminStrategyCapabilities(data);state.strategyDataCapabilitiesStatus='ready';return state.strategyDataCapabilities}).catch(error=>{state.strategyDataCapabilitiesStatus='error';throw error}).finally(()=>{state.strategyDataCapabilitiesRequest=null});state.strategyDataCapabilitiesRequest=request;return request}
function adminStrategyPolicyObject(strategy={}){const value=safeJson(strategy.strategy_policy_json,strategy.strategy_policy_json||null);return value&&typeof value==='object'&&!Array.isArray(value)?value:null}
function adminStrategyIndicatorDeclarations(strategy={}){const direct=safeJson(strategy.indicator_declarations,strategy.indicator_declarations||null);if(Array.isArray(direct))return structuredClone(direct);const policy=adminStrategyPolicyObject(strategy);return Array.isArray(policy?.indicators)?structuredClone(policy.indicators):[]}
function adminStrategyEmaCandidate(item={}){const id=String(item?.id||'').toLowerCase(),kind=String(item?.kind||item?.type||'').toLowerCase(),period=Number(item?.params?.period??item?.period);return id==='ema34'||id==='entry_ema34'||(kind==='ema'&&period===34)}
function adminStrategyCanonicalEma(item={}){const id=String(item?.id||'').toLowerCase(),kind=String(item?.kind||item?.type||'').toLowerCase(),period=Number(item?.params?.period??item?.period),field=String(item?.source?.field||item?.field||'close').toLowerCase(),bar=String(item?.source?.bar_scope||item?.bar_scope||'closed_only').toLowerCase();return id==='ema34'&&kind==='ema'&&period===34&&field==='close'&&bar==='closed_only'}
function adminStrategyEmaState(strategy={}){const policy=adminStrategyPolicyObject(strategy),declarations=adminStrategyIndicatorDeclarations(strategy),candidates=declarations.filter(adminStrategyEmaCandidate),canonical=candidates.find(adminStrategyCanonicalEma)||null,advancedDeclaration=candidates.find(item=>!adminStrategyCanonicalEma(item))||null,capability=strategy?.data_capabilities?.ema34&&typeof strategy.data_capabilities.ema34==='object'?strategy.data_capabilities.ema34:null,status=String(capability?.status||'').toLowerCase(),legacy=Boolean(Number(strategy?.['use_ema34_filter']||0)),declaredEnabled=candidates.some(item=>item.enabled!==false),capabilityEnabled=capability?.enabled!==false,policyMode=String(policy?.mode||'').toLowerCase(),runtimeEnabled=policyMode!=='off';return {policy,declarations,canonical:canonical||(status==='managed'&&capability?{id:'ema34',kind:'ema',enabled:capabilityEnabled,source:{timeframe:capability.timeframe}}:null),advanced:status==='advanced'||Boolean(advancedDeclaration),advancedDeclaration,enabled:runtimeEnabled&&(status==='managed'?capabilityEnabled:status==='advanced'?declaredEnabled:Boolean(canonical&&canonical.enabled!==false)),legacyOnly:status==='legacy_unconfigured'||(legacy&&!canonical&&!advancedDeclaration),policyMode,status,timeframe:String(capability?.timeframe||advancedDeclaration?.source?.timeframe||advancedDeclaration?.timeframe||canonical?.source?.timeframe||canonical?.timeframe||'').toUpperCase(),indicatorId:String(advancedDeclaration?.id||canonical?.id||'ema34')}}
function adminCanonicalEma34(timeframe){return {id:'ema34',kind:'ema',enabled:true,source:{timeframe:String(timeframe||'').toUpperCase(),field:'close',bar_scope:'closed_only'},params:{period:34,minimum_bars:34,warmup_target_bars:60,evidence_window:5}}}
function adminIndicatorDeclarationsForPayload(strategy,enabled,timeframe){const current=adminStrategyIndicatorDeclarations(strategy),info=adminStrategyEmaState(strategy);if(info.advanced)return current;const retained=current.filter(item=>!adminStrategyEmaCandidate(item));if(enabled)retained.push(adminCanonicalEma34(timeframe));return retained}
function adminStrategyDataSummary(plan,chanEnabled,chanTimeframes,emaEnabled,emaTimeframe,entryMethods){const labels=strategyEntryLabels;return `<div class="admin-strategy-data-summary-heading"><strong>本策略将收到</strong><span class="badge">实时更新</span></div><div class="admin-strategy-data-summary-body"><section><h4>基础行情</h4><ul>${plan.timeframes.map(item=>`<li><span>${escapeHtml(item.timeframe)}</span><strong>${Number(item.kline_count||0)} 根 K 线及基础技术摘要</strong></li>`).join('')||'<li><span>基础行情</span><strong>尚未选择行情周期</strong></li>'}</ul></section><section><h4>附加数据</h4><ul>${chanEnabled?`<li><span>缠论结构</span><strong>${escapeHtml(chanTimeframes.join('、')||'等待支持周期')}</strong></li>`:''}${emaEnabled?`<li><span>EMA34</span><strong>${escapeHtml(emaTimeframe||'等待选择周期')} · 已收盘 K 线</strong></li>`:''}<li><span>持仓与挂单</span><strong>策略参考数据 · 运行时自动提供（可能为空或不可用）</strong></li></ul></section><section><h4>输出能力</h4><p>${escapeHtml(entryMethods.map(item=>labels[item]||item).join('、')||'尚未选择')}</p></section></div>`}
function adminStrategyTechnicalFields(plan,chanEnabled,chanTimeframes,emaEnabled,emaTimeframe,emaIndicatorId='ema34'){const id=String(emaIndicatorId||'ema34');return JSON.stringify({market_data_plan:plan,chan:chanEnabled?{field:'strategy_context.timeframes.*.summary.chan',timeframes:chanTimeframes}:null,ema34:emaEnabled?{id,field:`strategy_context.indicators.${id}`,source:{timeframe:emaTimeframe,field:'close',bar_scope:'closed_only'}}:null},null,2)}
function adminStrategyTemplateText(kind,chanTimeframes,emaTimeframe){return kind==='chan'?`【缠论结构用途】\n- 使用周期：${chanTimeframes.join('、')||'请填写'}\n- 用途：{方向判断 / 入场确认 / 风险参考 / 其他，请填写}\n- 有效结构条件：{请填写}\n- 多周期冲突处理：{请填写}`:`【EMA34 用途】\n- 使用周期：${emaTimeframe||'请填写'}\n- 用途：{趋势过滤 / 入场确认 / 仅作参考 / 其他，请填写}\n- 多头条件：{请填写}\n- 空头条件：{请填写}\n- 不满足条件时：{请填写}`}
function platformStrategyPlan(strategy={}) {
  const plan=safeJson(strategy.market_data_plan_json,{})||{}
  const timeframes=Array.isArray(plan.timeframes)&&plan.timeframes.length?plan.timeframes:[{timeframe:'M30',kline_count:100}]
  return {primary_timeframe:String(plan.primary_timeframe||timeframes[0].timeframe).toUpperCase(),timeframes}
}
function legacyPlatformStrategyContent(){
  const items=state.platformStrategies.items||[]
  const platformCount=items.filter(item=>item.scope==='platform').length
  const privateCount=items.length-platformCount
  const active=items.filter(item=>item.visibility_status==='active'&&Number(item.is_active)!==0).length
  const scope=state.platformStrategies.scope||'all',search=String(state.platformStrategies.search||'').trim().toLowerCase()
  const visible=items.filter(item=>(scope==='all'||item.scope===scope)&&(!search||`${item.title||''} ${item.owner_nickname||''} ${item.owner_user_id||''} ${item.description||''}`.toLowerCase().includes(search)))
  const modelName=id=>(state.platformStrategies.models||[]).find(model=>Number(model.id)===Number(id))?.model_name||`模型 #${Number(id)}`
  return `<section class="strategy-admin-summary ai-asset-summary"><article><span>全部策略</span><strong>${items.length}</strong><small>平台与用户资产</small></article><article><span>平台策略</span><strong>${platformCount}</strong><small>管理员可配置</small></article><article><span>用户私有</span><strong>${privateCount}</strong><small>仅查看元数据</small></article><article><span>当前运行</span><strong>${active}</strong><small>有效且已上线</small></article></section>
    <section class="panel"><header class="section-head"><div><span class="eyebrow">策略资产总览</span><h2>全部策略</h2><p>完整查看平台与用户策略；私有策略保持只读，草稿与归档不会进入运行链路。</p></div><button class="primary-button" data-new-platform-strategy type="button">新建平台策略</button></header>
      <div class="ai-asset-toolbar"><div class="asset-scope-switch" aria-label="策略范围">${[['all','全部'],['platform','平台'],['private','用户私有']].map(([value,label])=>`<button type="button" class="${scope===value?'is-active':''}" data-strategy-scope="${value}">${label}</button>`).join('')}</div><label class="asset-search"><span data-icon="search" aria-hidden="true"></span><input class="input" data-strategy-search value="${escapeHtml(state.platformStrategies.search||'')}" placeholder="搜索策略、用户或 ID"></label><span class="asset-result-count">显示 ${visible.length} / ${items.length}</span></div>
      <div class="platform-strategy-list">${visible.map(item=>{const plan=platformStrategyPlan(item),methods=safeJson(item.entry_methods_json,[])||[],platform=item.scope==='platform',owner=platform?'平台运营':item.owner_nickname||`用户 #${Number(item.owner_user_id||0)}`;return `<article class="platform-strategy-row" data-platform-strategy="${Number(item.id)}"><div class="strategy-state ${item.visibility_status==='active'?'is-active':''}"></div><div class="platform-strategy-main"><div><strong>${escapeHtml(item.title||`策略 #${item.id}`)}</strong><span class="badge ${platform?'active':''}">${platform?'平台':'用户私有'}</span><span class="badge ${item.visibility_status==='active'?'active':item.visibility_status==='archived'?'expired':''}">${strategyVisibilityLabels[item.visibility_status]||'状态未知'}</span></div><p>${escapeHtml(item.description||'暂无策略说明')}</p><small>${escapeHtml(owner)} · ${escapeHtml((safeJson(item.symbols_json,[])||[]).join('、')||'未配置品种')} · ${escapeHtml(plan.primary_timeframe)} 主周期 · 版本 ${Number(item.version||1)}</small></div><div class="platform-strategy-actions"><span>${item.model_profile_id?escapeHtml(modelName(item.model_profile_id)):'默认模型'}</span>${platform?'<button class="secondary-button compact-action" data-edit-platform-strategy type="button">编辑</button>':'<span class="read-only-label">只读</span>'}</div></article>`}).join('')||'<div class="empty-state"><div><strong>没有符合条件的策略</strong><p>调整范围或搜索条件后再试。</p></div></div>'}</div>
    </section>`
}
function platformStrategyContent(){const content=legacyPlatformStrategyContent();return content.replace(/(<article class="platform-strategy-row" data-platform-strategy="(\d+)">[\s\S]*?<div class="platform-strategy-main"><div>)/g,(match,start,id)=>{const strategy=(state.platformStrategies.items||[]).find(item=>Number(item.id)===Number(id)),info=adminStrategyEmaState(strategy||{}),label=info.advanced?`高级 EMA34 · ${info.enabled?'已开启':'已关闭'}`:info.enabled?'EMA34 · 已开启':'EMA34 · 未开启';return `${start}<span class="badge ${info.enabled?'active':'muted'} strategy-ema-state-badge">${label}</span>`})}
function legacyPlatformStrategyEditorMarkup(strategy={}) {
  const plan=platformStrategyPlan(strategy), enabled=new Map(plan.timeframes.map(item=>[String(item.timeframe).toUpperCase(),Number(item.kline_count||100)])), methods=new Set(safeJson(strategy.entry_methods_json,['market','limit','stop','stop_limit'])||[]), ema=adminStrategyEmaState(strategy), emaTimeframe=ema.timeframe||plan.primary_timeframe;
  return `<form id="platformStrategyEditor" class="editor-form strategy-governance-editor" data-strategy-version="${Number(strategy.version||0)}"><div class="form-grid"><label class="field"><span>策略名称</span><input class="input" id="platformStrategyTitle" maxlength="120" required value="${escapeHtml(strategy.title||'')}"></label><label class="field"><span>可见状态</span><select class="select" id="platformStrategyVisibility">${Object.entries(strategyVisibilityLabels).map(([value,label])=>`<option value="${value}" ${strategy.visibility_status===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="field"><span>支持品种</span><input class="input" id="platformStrategySymbols" required value="${escapeHtml((safeJson(strategy.symbols_json,[])||[]).join(', '))}" placeholder="XAUUSD, EURUSD"></label><label class="field"><span>自动分析间隔（分钟）</span><input class="input" id="platformStrategyInterval" type="number" min="1" value="${Number(strategy.interval_minutes||5)}"></label><label class="field span-2"><span>策略说明</span><input class="input" id="platformStrategyDescription" maxlength="500" value="${escapeHtml(strategy.description||'')}"></label></div><section class="strategy-editor-block admin-strategy-data-section"><div><strong>提供给模型的数据</strong><small>系统提供事实，具体分析方法仍以策略正文为准。</small></div><div class="strategy-timeframe-grid">${strategyTimeframes.map(tf=>`<label><input type="checkbox" data-platform-timeframe="${tf}" ${enabled.has(tf)?'checked':''} aria-label="提供 ${tf} 行情"><strong>${tf}</strong><input class="input" data-platform-kline="${tf}" type="number" min="10" max="500" step="10" value="${enabled.get(tf)||100}" aria-label="${tf} K 线数量"><input type="radio" name="platformPrimaryTimeframe" value="${tf}" ${plan.primary_timeframe===tf?'checked':''} aria-label="将 ${tf} 设为主周期"></label>`).join('')}</div><div class="admin-strategy-capabilities"><section class="admin-strategy-capability-row"><label class="inline-check" for="platformStrategyChanData"><input id="platformStrategyChanData" type="checkbox" ${Number(strategy.use_chan_analysis)||strategy.data_capabilities?.chan?.enabled?'checked':''} aria-describedby="platformStrategyChanHelp" aria-controls="platformStrategyChanDetails" aria-expanded="false"><span><strong>提供缠论结构数据</strong><small id="platformStrategyChanHelp">为已选支持周期提供原始结构，不自动决定方向。</small></span></label><details id="platformStrategyChanDetails"><summary>查看说明</summary><p>支持周期：<strong data-platform-chan-timeframes>等待选择</strong></p></details></section><section class="admin-strategy-capability-row"><label class="inline-check" for="platformStrategyEma34Data"><input id="platformStrategyEma34Data" type="checkbox" ${ema.enabled&&!ema.advanced?'checked':''} ${ema.advanced?'disabled':''} aria-describedby="platformStrategyEma34Help platformStrategyEma34Status" aria-controls="platformStrategyEma34Details" aria-expanded="false"><span><strong>提供 EMA34 数据</strong><small id="platformStrategyEma34Help">按所选周期的已收盘 K 线计算，不自动作为开仓过滤条件。</small><small id="platformStrategyEma34Status" class="strategy-capability-status">${ema.advanced?'高级配置 · 简单开关不会覆盖':ema.legacyOnly?'旧配置未产生 EMA34 数据':ema.enabled?'已提供':'未提供'}</small></span></label><details id="platformStrategyEma34Details"><summary>查看周期与说明</summary><label class="strategy-inline-field" for="platformStrategyEma34Timeframe"><span>计算周期</span><select id="platformStrategyEma34Timeframe" aria-describedby="platformStrategyEma34TimeframeHelp"></select><small id="platformStrategyEma34TimeframeHelp">只能选择当前行情方案中已启用的周期。</small></label></details></section></div><div id="platformStrategyAdvancedState" class="strategy-advanced-policy-state" role="status" aria-live="polite"></div><div id="platformStrategyDataSummary" class="admin-strategy-data-summary" aria-live="polite"></div><details class="strategy-technical-details"><summary>查看技术字段</summary><pre id="platformStrategyTechnicalJson">{}</pre></details></section><section class="strategy-editor-block"><div><strong>允许的入场方式</strong><small>未选方式会从模型输出格式剔除，后端同时拒绝越界输出。</small></div><div class="strategy-entry-grid">${Object.entries(strategyEntryLabels).map(([value,label])=>`<label><input type="checkbox" data-platform-entry="${value}" ${methods.has(value)?'checked':''}><span>${label}</span></label>`).join('')}</div></section><div class="form-grid"><label class="field span-2"><span>绑定平台模型</span><select class="select" id="platformStrategyModel"><option value="">使用平台默认模型</option>${state.platformStrategies.models.map(model=>`<option value="${Number(model.id)}" ${Number(strategy.model_profile_id)===Number(model.id)?'selected':''}>${escapeHtml(model.model_name)}${Number(model.is_default)?' · 默认':''}</option>`).join('')}</select></label><label class="field span-2"><span>策略提示词</span><textarea class="input editor-textarea strategy-prompt" id="platformStrategyPrompt" rows="10" aria-describedby="platformStrategyPromptHelp platformStrategyEditorError" placeholder="只描述行情分析框架和信号判断方法；硬性风控由系统统一执行。">${escapeHtml(strategy.system_prompt||'')}</textarea><small id="platformStrategyPromptHelp" class="field-help">系统不会自动改写策略正文。</small></label></div><section class="admin-strategy-writing"><header><strong>如何在策略中使用</strong><small>仅在你点击时复制或插入。</small></header><div data-platform-writing-templates></div></section><div id="platformStrategyEditorError" class="strategy-editor-error" role="alert" aria-live="assertive" hidden></div><div class="form-actions">${strategy.id?'<button class="text-button danger-text" data-delete-platform-strategy type="button">删除策略</button>':''}<span class="action-spacer"></span><button class="secondary-button" data-close-entity-modal type="button">取消</button><button class="primary-button" type="submit" aria-busy="false"><span>保存平台策略</span></button></div></form>`;
}
function platformStrategyEditorMarkup(strategy={}){const info=adminStrategyEmaState(strategy||{}),markup=legacyPlatformStrategyEditorMarkup(strategy||{});return markup.replace(/(<input id="platformStrategyEma34Data"[^>]*>)/,match=>{const attrs=match.replace(/\sdisabled(?=[\s>])/g,'').replace(/\schecked(?=[\s>])/g,'');return attrs.replace('type="checkbox"',`type="checkbox"${info.enabled?' checked':''}`)}).replace(/(<small id="platformStrategyEma34Status"[^>]*>)[^<]*/,`$1${info.advanced?`高级配置 · ${info.enabled?'已提供':'已关闭'}`:info.legacyOnly?'旧配置未产生 EMA34 数据':info.enabled?'已提供':'未提供'}`)}
async function openPlatformStrategyEditor(strategy=null) {
  openEntityModal({title:strategy?'编辑平台策略':'新建平台策略',eyebrow:'策略运行治理',content:platformStrategyEditorMarkup(strategy||{})});
  const root=document.querySelector('#entityModalBody'),form=root?.querySelector('#platformStrategyEditor'); if(!root||!form)return;
  root.querySelector('[data-close-entity-modal]').onclick=closeEntityModal;
  const showError=message=>{const node=root.querySelector('#platformStrategyEditorError');node.hidden=!message;node.textContent=message||''};
  const sync=()=>{const selected=[...root.querySelectorAll('[data-platform-timeframe]:checked')].map(input=>String(input.dataset.platformTimeframe).toUpperCase());root.querySelectorAll('[data-platform-timeframe]').forEach(input=>{const tf=input.dataset.platformTimeframe,kline=root.querySelector(`[data-platform-kline="${tf}"]`),radio=root.querySelector(`input[name="platformPrimaryTimeframe"][value="${tf}"]`);if(kline)kline.disabled=!input.checked;if(radio){radio.disabled=!input.checked;if(!input.checked)radio.checked=false}});if(!root.querySelector('input[name="platformPrimaryTimeframe"]:checked'))root.querySelector(`[data-platform-timeframe][data-platform-timeframe="${selected[0]}"]`)?.closest('label')?.querySelector('input[type="radio"]')?.click();const planNow={primary_timeframe:root.querySelector('input[name="platformPrimaryTimeframe"]:checked')?.value||selected[0]||'',timeframes:selected.map(tf=>({timeframe:tf,kline_count:Number(root.querySelector(`[data-platform-kline="${tf}"]`)?.value)||100}))};const supported=(state.strategyDataCapabilities?.chan?.supported_timeframes||ADMIN_STRATEGY_CHAN_TIMEFRAMES).map(item=>String(item).toUpperCase()),chanTf=selected.filter(tf=>supported.includes(tf)),emaCheck=root.querySelector('#platformStrategyEma34Data'),emaSelect=root.querySelector('#platformStrategyEma34Timeframe'),emaState=adminStrategyEmaState(strategy||{}),configuredEmaTimeframe=emaState.timeframe,emaTimeframes=emaState.advanced&&configuredEmaTimeframe&&!selected.includes(configuredEmaTimeframe)?[configuredEmaTimeframe,...selected]:selected;emaSelect.innerHTML=emaTimeframes.map(tf=>`<option value="${tf}">${tf} · 已收盘 K 线</option>`).join('');if(!emaTimeframes.includes(emaSelect.value))emaSelect.value=configuredEmaTimeframe||selected[0]||'';emaSelect.disabled=emaState.advanced||!emaCheck.checked||emaCheck.disabled||!selected.length;root.querySelector('[data-platform-chan-timeframes]').textContent=chanTf.join('、')||'未选择支持周期';root.querySelector('#platformStrategyDataSummary').innerHTML=adminStrategyDataSummary(planNow,Boolean(root.querySelector('#platformStrategyChanData')?.checked),chanTf,Boolean(emaCheck.checked),emaSelect.value,[...root.querySelectorAll('[data-platform-entry]:checked')].map(input=>input.dataset.platformEntry));root.querySelector('#platformStrategyTechnicalJson').textContent=adminStrategyTechnicalFields(planNow,Boolean(root.querySelector('#platformStrategyChanData')?.checked),chanTf,Boolean(emaCheck.checked),emaSelect.value,emaState.indicatorId);const writing=[];if(root.querySelector('#platformStrategyChanData')?.checked)writing.push(['chan',adminStrategyTemplateText('chan',chanTf,emaSelect.value)]);if(emaCheck.checked)writing.push(['ema34',adminStrategyTemplateText('ema34',chanTf,emaSelect.value)]);root.querySelector('[data-platform-writing-templates]').innerHTML=writing.map(([key,text])=>`<article class="strategy-writing-template"><pre>${escapeHtml(text)}</pre><button type="button" class="secondary-button" data-platform-template="copy" data-template-key="${key}">复制写法模板</button><button type="button" class="secondary-button" data-platform-template="insert" data-template-key="${key}">插入到光标位置</button></article>`).join('')||'<p>开启能力后显示写法模板。</p>';const advanced=root.querySelector('#platformStrategyAdvancedState');advanced.hidden=!form.dataset.advancedState;advanced.textContent=form.dataset.advancedState?`检测到高级 EMA34 声明（${emaState.indicatorId} · ${emaState.timeframe||'未声明周期'}）。周期和参数只读，本页开关只控制数据提供，不会改写策略正文。当前：${emaCheck.checked?'已提供':'已关闭'}`:'';};
  const applyEmaLock=()=>{const info=adminStrategyEmaState(strategy||{}),check=root.querySelector('#platformStrategyEma34Data'),select=root.querySelector('#platformStrategyEma34Timeframe');if(check){check.disabled=false;check.indeterminate=false}if(select&&info.advanced)select.disabled=true};const initialEma=adminStrategyEmaState(strategy||{}),initialEmaCheck=root.querySelector('#platformStrategyEma34Data');if(initialEmaCheck){initialEmaCheck.disabled=false;initialEmaCheck.indeterminate=false;initialEmaCheck.checked=initialEma.enabled}form.dataset.advancedState=initialEma.advanced?'1':'';root.querySelectorAll('[data-platform-timeframe], [data-platform-kline], [data-platform-entry], #platformStrategyChanData, #platformStrategyEma34Data, #platformStrategyEma34Timeframe').forEach(input=>input.addEventListener('change',()=>{sync();applyEmaLock()}));sync();applyEmaLock();
  root.querySelectorAll('details').forEach(details=>details.addEventListener('toggle',()=>details.previousElementSibling?.querySelector('input')?.setAttribute('aria-expanded',String(details.open))));
  root.addEventListener('click',async event=>{const button=event.target.closest?.('[data-platform-template]');if(!button)return;const text=button.closest('.strategy-writing-template')?.querySelector('pre')?.textContent||'',textarea=root.querySelector('#platformStrategyPrompt');if(button.dataset.platformTemplate==='copy'){try{await navigator.clipboard?.writeText(text);toast('写法模板已复制','success')}catch{toast('复制失败，请手动选择模板','warning')}}else{const start=Number.isInteger(textarea.selectionStart)?textarea.selectionStart:textarea.value.length;textarea.setRangeText(`\n\n${text}`,start,start,'end');textarea.focus();toast('模板已插入光标位置','success')}});
  try{await loadAdminStrategyDataCapabilities();sync();applyEmaLock()}catch{showError('策略数据能力目录暂不可用，未知高级配置不会被覆盖；请取消或稍后重试');root.querySelectorAll('[data-platform-timeframe], #platformStrategyChanData, #platformStrategyEma34Data').forEach(input=>{if(!input.disabled)input.disabled=true})}
  root.querySelector('[data-delete-platform-strategy]')?.addEventListener('click',async()=>{try{const {preview}=await api(`/api/admin/ai/strategies/${strategy.id}/delete-preview`);const message=`影响 ${Number(preview.subscription_count||0)} 条订阅、${Number(preview.affected_user_count||0)} 位用户，其中 ${Number(preview.active_subscription_count||0)} 条正在运行。请输入策略名称“${preview.title}”确认。`;if(!await confirmAction('永久删除平台策略？',message,'确认删除',true,preview.title))return;await api(`/api/admin/ai/strategies/${strategy.id}`,{method:'DELETE',body:JSON.stringify({confirm_title:preview.title,confirm_version:preview.version,expected_active_subscriptions:preview.active_subscription_count,confirm_stop_subscriptions:true})});toast('平台策略已删除，相关运行订阅已停止','success');closeEntityModal();await loadPlatformStrategies()}catch(error){handleError(error)}});
  form.onsubmit=async event=>{event.preventDefault();if(state.strategyDataCapabilitiesStatus!=='ready'){showError('策略数据能力目录暂不可用，请重试后再保存');return}const button=event.submitter||form.querySelector('button[type="submit"]'),timeframes=[...root.querySelectorAll('[data-platform-timeframe]:checked')].map(input=>({timeframe:input.dataset.platformTimeframe,kline_count:Number(root.querySelector(`[data-platform-kline="${input.dataset.platformTimeframe}"]`).value||100)})),entries=[...root.querySelectorAll('[data-platform-entry]:checked')].map(input=>input.dataset.platformEntry),primary=root.querySelector('input[name="platformPrimaryTimeframe"]:checked')?.value||timeframes[0]?.timeframe||'',chanEnabled=Boolean(root.querySelector('#platformStrategyChanData')?.checked),supportedChanTimeframes=(state.strategyDataCapabilities?.chan?.supported_timeframes||ADMIN_STRATEGY_CHAN_TIMEFRAMES).map(item=>String(item).toUpperCase()),emaCheck=root.querySelector('#platformStrategyEma34Data'),emaEnabled=Boolean(emaCheck?.checked),emaTimeframe=String(root.querySelector('#platformStrategyEma34Timeframe')?.value||'').toUpperCase(),emaState=adminStrategyEmaState(strategy||{});if(!timeframes.length)return showError('请至少启用一个行情周期');if(!entries.length)return showError('请至少允许一种入场方式');if(chanEnabled&&!timeframes.some(item=>supportedChanTimeframes.includes(String(item.timeframe).toUpperCase())))return showError(`缠论至少需要一个支持周期：${supportedChanTimeframes.join('、')}`);if(emaEnabled&&!emaTimeframe)return showError('请先选择 EMA34 计算周期');if(emaEnabled&&!timeframes.some(item=>item.timeframe===emaTimeframe))return showError('EMA34 周期必须来自当前已启用的行情周期');let confirmed=false;if(emaState.enabled&&!emaEnabled){if(!await confirmAction('确认关闭 EMA34 数据？','关闭后运行时不再提供 EMA34 数据；不会修改策略正文，请由你自行删除或调整策略中的 EMA34 逻辑。','确认关闭'))return showError('你取消了 EMA34 数据关闭，草稿仍保留')}if(emaEnabled&&!emaState.enabled&&emaState.policyMode==='off'){if(!await confirmAction('确认提供 EMA34 数据？','确认后将启用 EMA34 数据计算，不会自动加入交易规则。','确认启用'))return showError('你取消了 EMA34 数据启用，草稿仍保留');confirmed=true}const payload={scope:'platform',title:root.querySelector('#platformStrategyTitle').value.trim(),description:root.querySelector('#platformStrategyDescription').value.trim(),symbols:root.querySelector('#platformStrategySymbols').value.split(',').map(value=>value.trim()).filter(Boolean),visibility_status:root.querySelector('#platformStrategyVisibility').value,interval_minutes:Number(root.querySelector('#platformStrategyInterval').value||5),market_data_plan:{primary_timeframe:primary,timeframes},entry_methods:entries,use_chan_analysis:chanEnabled,use_ema34_filter:emaEnabled,include_portfolio_context:false,model_profile_id:root.querySelector('#platformStrategyModel').value?Number(root.querySelector('#platformStrategyModel').value):null,system_prompt:root.querySelector('#platformStrategyPrompt').value.trim()};if(!emaState.advanced)payload.indicator_declarations=adminIndicatorDeclarationsForPayload(strategy||{},emaEnabled,emaTimeframe);if(strategy?.id){payload.expected_version=Number(strategy.version||form.dataset.strategyVersion||1)}if(confirmed)payload.confirm_enable_data_runtime=true;button.disabled=true;button.setAttribute('aria-busy','true');showError('');try{await api(strategy?`/api/admin/ai/strategies/${strategy.id}`:'/api/admin/ai/strategies',{method:strategy?'PUT':'POST',body:JSON.stringify(payload)});toast('平台策略已保存并同步运行配置','success');closeEntityModal();await loadPlatformStrategies()}catch(error){showError(error.code==='strategy_version_conflict'?'策略已在其他位置更新，当前草稿已保留，请刷新后对比再保存':error.message||'策略保存失败，当前草稿已保留')}finally{button.disabled=false;button.setAttribute('aria-busy','false')}};
}
function renderPlatformStrategies(){const content=document.querySelector('#aiOperationsContent');if(!content)return;content.innerHTML=platformStrategyContent();renderIcons(content);document.querySelector('[data-new-platform-strategy]')?.addEventListener('click',()=>openPlatformStrategyEditor());document.querySelectorAll('[data-strategy-scope]').forEach(button=>button.onclick=()=>{state.platformStrategies.scope=button.dataset.strategyScope;renderPlatformStrategies()});document.querySelector('[data-strategy-search]')?.addEventListener('input',event=>{state.platformStrategies.search=event.target.value;renderPlatformStrategies();const input=document.querySelector('[data-strategy-search]');input?.focus();input?.setSelectionRange(input.value.length,input.value.length)});document.querySelectorAll('[data-edit-platform-strategy]').forEach(button=>button.onclick=()=>{const row=button.closest('[data-platform-strategy]'),strategy=state.platformStrategies.items.find(item=>Number(item.id)===Number(row.dataset.platformStrategy)&&item.scope==='platform');if(strategy)openPlatformStrategyEditor(strategy)})}
async function loadPlatformStrategies(){const [strategies,models]=await Promise.all([api('/api/admin/ai/strategies'),api('/api/ai/model-profiles?scope=platform')]);const previous=state.platformStrategies;state.platformStrategies={...previous,items:strategies.strategies||[],models:(models.profiles||[]).filter(item=>item.scope==='platform'&&item.status==='active'),loaded:true};renderPlatformStrategies()}
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
  const models = setup.profiles.map(profile => `<label class="compare-model ${compare.modelIds.has(Number(profile.id)) ? 'is-selected' : ''}"><input type="checkbox" data-compare-model="${Number(profile.id)}" ${compare.modelIds.has(Number(profile.id)) ? 'checked' : ''}><span><strong>${escapeHtml(profile.model_name || '未命名模型')}</strong><small>${escapeHtml(providerLabels[profile.provider] || '模型服务')} ${profile.thinking_enabled ? '· 深度思考' : ''}</small></span><em>${compare.modelIds.has(Number(profile.id)) ? '已选择' : '可用'}</em></label>`).join('')
  const totalPages = Math.max(1, Math.ceil(Number(compare.pagination?.total || 0) / Number(compare.pagination?.page_size || 10)))
  const canRun = compare.selected.size >= 2 && compare.modelIds.size >= 2 && compare.modelIds.size <= 5 && strategy && compare.symbol
  const activeJobs=(compare.jobs||[]).filter(job=>['queued','running','cancelling'].includes(job.status)).length
  return `<section class="ai-module-summary"><div><small>可评测策略</small><strong>${setup.strategies.length}</strong></div><div><small>可用模型</small><strong>${setup.profiles.length}</strong></div><div><small>已选信号</small><strong>${compare.selected.size}</strong></div><div><small>运行任务</small><strong>${activeJobs}</strong></div></section><section class="compare-workspace">
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
    return `<article class="compare-result-row ${model.status!=='success'?'has-error':''}"><span class="result-rank">${index+1}</span><div class="result-model"><strong>${escapeHtml(model.model_name || `模型 #${model.model_id}`)}</strong><small>${escapeHtml(providerLabels[model.provider] || '模型服务')} · ${Number(score.actionable_count || 0)} 次出手</small></div><div><span>方向质量</span><strong>${compareResultValue(score.direction_quality_score)}</strong></div><div><span>方向准确率</span><strong>${compareResultValue(score.directional_accuracy,'%')}</strong></div><div><span>输出合规率</span><strong>${compareResultValue(score.output_compliance_rate,'%')}</strong></div><div><span>平均置信度</span><strong>${compareResultValue(score.average_confidence,'%')}</strong></div><div><span>模拟净收益</span><strong class="${profit<0?'negative':profit>0?'positive':''}">${Number.isFinite(profit)?`${profit>0?'+':''}${profit.toFixed(2)}`:simulation.status==='unavailable'?'证据不足':'--'}</strong></div></article>`
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
  document.querySelector('#compareRun')?.addEventListener('click',async buttonEvent=>{const button=buttonEvent.currentTarget;button.disabled=true;compare.loading=true;renderModelCompareContent();try{const data=await api('/api/admin/ai/model-compare/jobs',{method:'POST',body:JSON.stringify({strategy_id:compare.strategyId,symbol:compare.symbol,model_ids:[...compare.modelIds],data_source:'snapshots',snapshot_ids:[...compare.selected.keys()],evaluation_mode:'sampled',backtest:{use_bridge_account_settings:true}})});toast('模型评测任务已开始','success');compare.selected.clear();await loadModelCompareJobs();if(data.job?.id)state.modelCompare.polling=setTimeout(()=>loadModelCompareJobs().catch(handleError),1200)}catch(error){handleError(error)}finally{compare.loading=false;renderModelCompareContent()}})
  document.querySelectorAll('[data-open-compare-result]').forEach(button=>button.addEventListener('click',()=>openModelCompareResult(button.closest('[data-compare-job]').dataset.compareJob).catch(handleError)))
  document.querySelectorAll('[data-delete-compare-job]').forEach(button=>button.addEventListener('click',async()=>{const jobId=button.closest('[data-compare-job]').dataset.compareJob;if(!await confirmAction('删除模型评测记录？','删除后无法恢复，但不会影响模型配置和历史信号。','确认删除',true))return;try{await api(`/api/admin/ai/model-compare/jobs/${encodeURIComponent(jobId)}`,{method:'DELETE'});toast('评测记录已删除','success');await loadModelCompareJobs()}catch(error){handleError(error)}}))
}
const providerLabels={deepseek:'DeepSeek',gpt:'OpenAI',kimi:'Moonshot Kimi',kimi_code:'Kimi Code 订阅',qwen:'通义千问',zhipu:'智谱 AI',doubao:'火山方舟',volcengine_agent_plan:'火山方舟 Agent Plan',openai_compatible:'自定义 OpenAI 兼容'}
const DEFAULT_MODEL_TOKEN_LIMITS={context_window_tokens:1048576,max_input_tokens:1048576,max_output_tokens:393216}
function modelTokenLimits(profile={}){
  const source=profile.token_limits||profile.capabilities||profile.model_capabilities||{}
  const value=key=>{const number=Number(profile[key]??source[key]);return Number.isInteger(number)&&number>0?number:DEFAULT_MODEL_TOKEN_LIMITS[key]}
  return {context_window_tokens:value('context_window_tokens'),max_input_tokens:value('max_input_tokens'),max_output_tokens:value('max_output_tokens')}
}
function modelTokenStatus(profile={}){
  const source=profile.token_limits||profile.capabilities||profile.model_capabilities||{}
  const raw=String(profile.token_limits_status??source.token_limits_status??source.status??'').toLowerCase()
  if(['confirmed','manual_confirmed','verified'].includes(raw)) return {label:'已人工确认',tone:'active'}
  if(['stale','needs_confirmation'].includes(raw)) return {label:'待重新确认',tone:'warning'}
  return {label:'待人工确认',tone:'warning'}
}
function formatModelTokenCount(value){return Number(value||0).toLocaleString('zh-CN')}
function modelTokenCapabilitiesMarkup(profile={}){
  const limits=modelTokenLimits(profile),status=modelTokenStatus(profile)
  return `<span class="model-token-capabilities">上下文 ${formatModelTokenCount(limits.context_window_tokens)} · 输入 ${formatModelTokenCount(limits.max_input_tokens)} · 输出 ${formatModelTokenCount(limits.max_output_tokens)}</span><span class="badge ${status.tone}">${status.label}</span>`
}
const featureLabels={review_generation_enabled:['复盘生成','允许系统生成日复盘与月复盘'],experience_memory_enabled:['统一记忆库','允许确认后的经验沉淀并参与推理'],memory_compression_enabled:['记忆库压缩','允许容量触发与月复盘压缩'],retrieval_shadow_enabled:['旧影子检索（已退役）','统一记忆库不再执行按需检索']}
function platformModelsContent() {
  const data=state.platformModels,allProfiles=data.profiles||[],profiles=allProfiles.filter(item=>item.scope==='platform'),policy=data.policy||{},health=data.governance||{},globalFlags=(health.feature_flags||[]).find(item=>item.scope==='global')||{},rollouts=health.risk_rule_rollouts||[]
  const scope=state.platformModels.scope||'all',search=String(state.platformModels.search||'').trim().toLowerCase()
  const visible=allProfiles.filter(item=>(scope==='all'||item.scope===scope)&&(!search||`${item.model_name||''} ${item.provider||''} ${item.owner_nickname||''} ${item.owner_email||''} ${item.owner_user_id||''}`.toLowerCase().includes(search)))
  const platformCount=profiles.length,userCount=allProfiles.length-platformCount,activeCount=allProfiles.filter(item=>item.status==='active').length
  const inventory=`<section class="strategy-admin-summary ai-asset-summary"><article><span>全部模型</span><strong>${allProfiles.length}</strong><small>完整模型资产</small></article><article><span>平台模型</span><strong>${platformCount}</strong><small>共享推理资源</small></article><article><span>用户模型</span><strong>${userCount}</strong><small>凭证已脱敏</small></article><article><span>当前可用</span><strong>${activeCount}</strong><small>状态为启用</small></article></section><section class="panel ai-model-inventory"><header class="section-head"><div><span class="eyebrow">模型资产总览</span><h2>全部模型</h2><p>查看平台与用户模型的服务商、归属和状态；用户密钥不会在管理端返回。</p></div><button class="primary-button" data-new-platform-model type="button">添加平台模型</button></header><div class="ai-asset-toolbar"><div class="asset-scope-switch" aria-label="模型范围">${[['all','全部'],['platform','平台'],['user','用户']].map(([value,label])=>`<button type="button" class="${scope===value?'is-active':''}" data-model-scope="${value}">${label}</button>`).join('')}</div><label class="asset-search"><span data-icon="search" aria-hidden="true"></span><input class="input" data-model-search value="${escapeHtml(state.platformModels.search||'')}" placeholder="搜索模型、服务商或用户"></label><span class="asset-result-count">显示 ${visible.length} / ${allProfiles.length}</span></div><div class="platform-model-list ai-all-model-list">${visible.map(profile=>{const platform=profile.scope==='platform',owner=platform?'平台运营':profile.owner_nickname||profile.owner_email||`用户 #${Number(profile.owner_user_id||0)}`;return `<article class="platform-model-row" data-platform-model="${Number(profile.id)}"><span class="provider-mark">${escapeHtml((providerLabels[profile.provider]||'模型').slice(0,1))}</span><div><div class="model-title-line"><strong>${escapeHtml(profile.model_name||`模型 #${profile.id}`)}</strong><span class="badge ${platform?'active':''}">${platform?'平台':'用户'}</span></div><small>${escapeHtml(providerLabels[profile.provider]||'模型服务')} · ${escapeHtml(owner)} · ${profile.has_api_key?'凭证已配置':'凭证未配置'}${profile.thinking_enabled?' · 深度思考':''} · ${modelTokenCapabilitiesMarkup(profile)}</small></div><span class="badge ${profile.status==='active'?'active':'expired'}">${profile.status==='active'?'可用':'停用'}</span><div class="row-actions">${platform?`<button class="text-button" data-test-platform-model type="button">测试</button>${Number(profile.is_default)?'<span class="badge active">默认</span>':'<button class="text-button" data-default-platform-model type="button">设为默认</button>'}<button class="icon-button compact-icon" data-edit-platform-model type="button" aria-label="编辑平台模型"><span data-icon="more"></span></button>`:'<span class="read-only-label">只读</span>'}</div></article>`}).join('')||'<div class="empty-state compact-empty">没有符合条件的模型</div>'}</div></section>`
  return `${inventory}<section class="platform-model-layout section-gap"><article class="panel platform-model-panel"><header class="section-head"><div><span class="eyebrow">平台模型配置</span><h2>共享模型</h2><p>以下配置供平台策略、复盘和授权用户共同使用。</p></div></header><div class="platform-model-list">${profiles.map(profile=>`<article class="platform-model-row"><span class="provider-mark">${escapeHtml((providerLabels[profile.provider]||'模型').slice(0,1))}</span><div><strong>${escapeHtml(profile.model_name)}</strong><small>${escapeHtml(providerLabels[profile.provider]||'模型服务')} · ${profile.has_api_key?'密钥已配置':'密钥未配置'}</small></div>${Number(profile.is_default)?'<span class="badge active">默认模型</span>':'<span class="badge">备用模型</span>'}</article>`).join('')||'<div class="empty-state compact-empty">还没有配置平台模型</div>'}</div></article><article class="panel"><header class="section-head"><div><span class="eyebrow">共享策略</span><h2>使用范围与配额</h2><p>决定哪些任务可以使用平台模型，以及单用户每日上限。</p></div></header><form class="platform-policy-form" id="platformModelPolicy"><div class="policy-switch-grid"><label><input type="checkbox" data-policy-flag="share_for_manual" ${Number(policy.share_for_manual)?'checked':''}><span><strong>手动分析</strong><small>用户没有私有模型时可使用</small></span></label><label><input type="checkbox" data-policy-flag="share_for_auto" ${Number(policy.share_for_auto)?'checked':''}><span><strong>自动分析</strong><small>私有模型缺失时使用平台模型</small></span></label><label><input type="checkbox" data-policy-flag="share_for_review" ${Number(policy.share_for_review)?'checked':''}><span><strong>复盘任务</strong><small>生成日复盘与月复盘</small></span></label><label><input type="checkbox" data-policy-flag="share_for_memory_compression" ${Number(policy.share_for_memory_compression)?'checked':''}><span><strong>记忆压缩</strong><small>压缩对应策略的统一记忆库</small></span></label></div><div class="form-grid"><label class="field"><span>允许会员</span><select class="select" id="platformAllowedPlans" multiple size="2"><option value="plus" ${safeJson(policy.allowed_plans,[]).includes('plus')?'selected':''}>Plus 用户</option><option value="pro" ${safeJson(policy.allowed_plans,['pro']).includes('pro')?'selected':''}>Pro 用户</option></select></label><label class="field"><span>每日请求上限 / 用户</span><input class="input" id="platformDailyRequests" type="number" min="1" value="${Number(policy.daily_requests_per_user||100)}"></label><label class="field"><span>每日令牌告警阈值 / 用户</span><input class="input" id="platformDailyTokens" type="number" min="1000" step="1000" value="${Number(policy.daily_tokens_per_user||500000)}"><small>仅用于用量统计和告警，不会阻止模型调用。</small></label></div><div class="form-actions"><button class="primary-button" type="submit">保存共享策略</button></div></form></article></section><section class="panel section-gap"><header class="section-head"><div><span class="eyebrow">灰度与安全</span><h2>AI 功能治理</h2><p>平台级开关影响所有用户；强制风控规则不能切换为影子模式。</p></div><button class="secondary-button" id="refreshAiGovernance" type="button">刷新状态</button></header><div class="governance-grid"><div><h3>平台功能开关</h3><div class="governance-switches">${Object.entries(featureLabels).map(([key,[label,description]])=>`<label><input type="checkbox" data-feature-flag="${key}" ${globalFlags[key]?'checked':''}><span><strong>${label}</strong><small>${description}</small></span></label>`).join('')}</div><button class="secondary-button" id="saveAiFeatureFlags" type="button">保存功能开关</button></div><div><h3>规则灰度</h3><div class="rollout-list">${rollouts.map(item=>`<label><span><strong>${escapeHtml(riskRuleLabel(item.rule_code))}</strong><small>${Number(item.forced_enforce)?'系统强制执行':'可切换影子评估'}</small></span><select class="select" data-rollout-rule="${escapeHtml(item.rule_code)}" ${Number(item.forced_enforce)?'disabled':''}><option value="enforce" ${item.mode!=='shadow'?'selected':''}>正式执行</option><option value="shadow" ${item.mode==='shadow'?'selected':''}>仅影子评估</option></select></label>`).join('')||'<div class="empty-inline">暂无规则灰度记录</div>'}</div></div><div><h3>凭证维护</h3><div class="credential-state"><span>最近轮换</span><strong>${health.credential_migration?.status==='succeeded'?'已完成':health.credential_migration?.status==='failed'?'失败':'尚未执行'}</strong><small>${escapeHtml(formatDate(health.credential_migration?.completed_at||health.credential_migration?.started_at,true))}</small></div><button class="secondary-button full-button" id="rotateModelCredentials" type="button">重新加密全部模型密钥</button><button class="text-button danger-text full-button" id="clearLegacyCredentials" type="button">清理已验证的旧明文凭证</button></div></div></section>`
}
async function loadPlatformModels() {
  const [profiles,policy,governance]=await Promise.all([api('/api/ai/model-profiles?scope=platform'),api('/api/ai/platform-model-policy'),api('/api/ai/admin/rollout-health')])
  state.platformModels={...state.platformModels,profiles:profiles.profiles||[],policy:policy.policy||{},governance:governance.health||{}}
  renderPlatformModels()
}
function platformModelEditorMarkup(profile={}) {
  const selected=value=>profile.provider===value?'selected':''
  const limits=modelTokenLimits(profile)
  return `<form id="platformModelEditor" class="editor-form"><div class="form-grid"><label class="field"><span>模型服务</span><select class="select" id="platformModelProvider">${Object.entries(providerLabels).map(([value,label])=>`<option value="${value}" ${selected(value)}>${label}</option>`).join('')}</select></label><label class="field"><span>模型名称</span><input class="input" id="platformModelName" required value="${escapeHtml(profile.model_name||'deepseek-chat')}"></label><label class="field span-2"><span>接口地址</span><input class="input" id="platformModelBaseUrl" value="${escapeHtml(profile.api_base_url||'')}" placeholder="留空使用服务商默认地址"></label><label class="field span-2"><span>API 密钥</span><input class="input" id="platformModelApiKey" type="password" autocomplete="new-password" placeholder="${profile.has_api_key?'已安全配置；留空保持不变':'请输入 API 密钥'}"></label><div class="field-help span-2 model-token-capability-note">默认值来自 DeepSeek 初始能力：上下文窗口 1024K、最大输入 1024K、最大输出 384K。其他模型请按当前服务商和模型文档核对后修改；如果思考模型的协议把思维链计入输出，思维链会占用最大输出额度。</div><label class="field"><span>上下文窗口（tokens）</span><input class="input" id="platformModelContextWindowTokens" type="number" min="1" step="1" value="${limits.context_window_tokens}"><small class="field-help">模型一次请求可使用的上下文总量。</small></label><label class="field"><span>最大输入（tokens）</span><input class="input" id="platformModelMaxInputTokens" type="number" min="1" step="1" value="${limits.max_input_tokens}"><small class="field-help">按当前模型文档填写可接受的最大输入。</small></label><label class="field"><span>最大输出（tokens）</span><input class="input" id="platformModelMaxOutputTokens" type="number" min="1" step="1" value="${limits.max_output_tokens}"><small class="field-help">回答与协议计入的思维链共用此额度。</small></label><label class="field"><span>请求超时（毫秒）</span><input class="input" id="platformModelTimeout" type="number" min="30000" max="600000" step="1000" value="${Number(profile.request_timeout_ms||120000)}"><small class="field-help">仅用于保存时的单次验证和独立测试连接。</small></label><label class="field"><span>温度</span><input class="input" id="platformModelTemperature" type="number" min="0" max="2" step="0.1" value="${Number(profile.temperature??0.3)}"></label><label class="field"><span>推理强度</span><select class="select" id="platformModelEffort"><option value="low" ${profile.reasoning_effort==='low'?'selected':''}>低</option><option value="medium" ${profile.reasoning_effort==='medium'?'selected':''}>中</option><option value="high" ${profile.reasoning_effort==='high'?'selected':''}>高</option><option value="max" ${!profile.reasoning_effort||profile.reasoning_effort==='max'?'selected':''}>最高</option></select></label><label class="inline-check span-2"><input id="platformModelThinking" type="checkbox" ${profile.thinking_enabled?'checked':''}><span><strong>启用深度思考</strong><small>仅对服务商支持的模型生效，响应时间会增加。</small></span></label></div><div class="form-actions">${profile.id?'<button class="text-button danger-text" data-delete-platform-model type="button">删除模型</button>':''}<span class="action-spacer"></span><button class="secondary-button" data-close-entity-modal type="button">取消</button><button class="primary-button" type="submit">保存并验证</button></div></form>`
}
function openPlatformModelEditor(profile=null) {
  openEntityModal({title:profile?'编辑平台模型':'添加平台模型',eyebrow:'共享模型配置',content:platformModelEditorMarkup(profile||{})})
  const root=document.querySelector('#entityModalBody')
  root.querySelector('[data-close-entity-modal]').onclick=closeEntityModal
  root.querySelector('[data-delete-platform-model]')?.addEventListener('click',async()=>{try{const impact=(await api(`/api/ai/model-profiles/${profile.id}/delete-impact?scope=platform`)).impact;if(!impact.can_delete)return handleError(new Error(impact.is_default?'默认模型不能删除，请先更换默认模型':'该模型仍被策略使用，不能删除'));if(!await confirmAction('删除平台模型？',`确认删除“${profile.model_name}”？模型配置和密钥会被永久移除。`,'确认删除',true))return;await api(`/api/ai/model-profiles/${profile.id}?scope=platform`,{method:'DELETE',body:JSON.stringify({confirm_name:profile.model_name,confirm_id:profile.id})});toast('平台模型已删除','success');closeEntityModal();await loadPlatformModels()}catch(error){handleError(error)}})
  root.querySelector('#platformModelEditor').onsubmit=async event=>{event.preventDefault();const button=event.submitter||root.querySelector('#platformModelEditor button[type="submit"]'),payload={scope:'platform',provider:root.querySelector('#platformModelProvider').value,model_name:root.querySelector('#platformModelName').value.trim(),api_base_url:root.querySelector('#platformModelBaseUrl').value.trim()||null,api_key:root.querySelector('#platformModelApiKey').value.trim()||undefined,context_window_tokens:Number(root.querySelector('#platformModelContextWindowTokens').value),max_input_tokens:Number(root.querySelector('#platformModelMaxInputTokens').value),max_output_tokens:Number(root.querySelector('#platformModelMaxOutputTokens').value),request_timeout_ms:Number(root.querySelector('#platformModelTimeout').value),temperature:Number(root.querySelector('#platformModelTemperature').value),thinking_enabled:root.querySelector('#platformModelThinking').checked,reasoning_effort:root.querySelector('#platformModelEffort').value};if(profile?.updated_at)payload.expected_updated_at=profile.updated_at;if(![payload.context_window_tokens,payload.max_input_tokens,payload.max_output_tokens].every(value=>Number.isInteger(value)&&value>0)){handleError(new Error(ADMIN_AI_ERROR_MESSAGES.model_token_limits_invalid));return}button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='正在验证…';try{await api(profile?`/api/ai/model-profiles/${profile.id}`:'/api/ai/model-profiles',{method:profile?'PUT':'POST',body:JSON.stringify(payload),timeout:adminModelRequestTransportTimeoutMs(payload.request_timeout_ms)});toast('模型已验证并保存','success');closeEntityModal();await loadPlatformModels()}catch(error){handleError(error)}finally{button.disabled=false;button.removeAttribute('aria-busy');button.textContent='保存并验证'} }
}
function renderPlatformModels() {
  const content=document.querySelector('#aiOperationsContent');if(!content)return;content.innerHTML=platformModelsContent();renderIcons(content)
  document.querySelector('[data-new-platform-model]')?.addEventListener('click',()=>openPlatformModelEditor())
  document.querySelectorAll('[data-model-scope]').forEach(button=>button.onclick=()=>{state.platformModels.scope=button.dataset.modelScope;renderPlatformModels()})
  document.querySelector('[data-model-search]')?.addEventListener('input',event=>{state.platformModels.search=event.target.value;renderPlatformModels();const input=document.querySelector('[data-model-search]');input?.focus();input?.setSelectionRange(input.value.length,input.value.length)})
  document.querySelectorAll('[data-edit-platform-model]').forEach(button=>button.onclick=()=>{const profile=state.platformModels.profiles.find(item=>item.scope==='platform'&&Number(item.id)===Number(button.closest('[data-platform-model]').dataset.platformModel));if(profile)openPlatformModelEditor(profile)})
  document.querySelectorAll('[data-test-platform-model]').forEach(button=>button.onclick=async()=>{const id=button.closest('[data-platform-model]').dataset.platformModel;button.disabled=true;button.textContent='测试中…';try{const result=await api(`/api/ai/model-profiles/${id}/test`,{method:'POST',body:JSON.stringify({scope:'platform'})});toast(`模型连接正常，响应 ${(Number(result.latency_ms||0)/1000).toFixed(1)} 秒`,'success')}catch(error){handleError(error)}finally{button.disabled=false;button.textContent='测试'}})
  document.querySelectorAll('[data-default-platform-model]').forEach(button=>button.onclick=async()=>{const id=button.closest('[data-platform-model]').dataset.platformModel;try{await api(`/api/ai/model-profiles/${id}/default`,{method:'POST',body:JSON.stringify({scope:'platform'})});toast('默认平台模型已更新','success');await loadPlatformModels()}catch(error){handleError(error)}})
  document.querySelector('#platformModelPolicy').onsubmit=async event=>{event.preventDefault();const payload={allowed_plans:[...document.querySelector('#platformAllowedPlans').selectedOptions].map(option=>option.value),daily_requests_per_user:Number(document.querySelector('#platformDailyRequests').value),daily_tokens_per_user:Number(document.querySelector('#platformDailyTokens').value)};document.querySelectorAll('[data-policy-flag]').forEach(input=>payload[input.dataset.policyFlag]=input.checked);const button=event.submitter;button.disabled=true;try{await api('/api/ai/platform-model-policy',{method:'PUT',body:JSON.stringify(payload)});toast('平台模型共享策略已保存','success');await loadPlatformModels()}catch(error){handleError(error);button.disabled=false}}
  document.querySelector('#saveAiFeatureFlags').onclick=async event=>{const flags={};document.querySelectorAll('[data-feature-flag]').forEach(input=>flags[input.dataset.featureFlag]=input.checked);event.currentTarget.disabled=true;try{await api('/api/ai/admin/feature-flags',{method:'PUT',body:JSON.stringify({flags})});toast('AI 功能开关已保存','success');await loadPlatformModels()}catch(error){handleError(error);event.currentTarget.disabled=false}}
  document.querySelectorAll('[data-rollout-rule]').forEach(select=>select.onchange=async()=>{select.disabled=true;try{await api(`/api/ai/admin/risk-rule-rollouts/${encodeURIComponent(select.dataset.rolloutRule)}`,{method:'PUT',body:JSON.stringify({mode:select.value})});toast('规则灰度状态已更新','success')}catch(error){handleError(error);await loadPlatformModels()}finally{select.disabled=false}})
  document.querySelector('#refreshAiGovernance').onclick=()=>loadPlatformModels().catch(handleError)
  document.querySelector('#rotateModelCredentials').onclick=async event=>{if(!await confirmAction('重新加密模型密钥？','系统会用当前主密钥重新加密全部模型凭证。运行期间已有请求不受影响。','确认轮换'))return;event.currentTarget.disabled=true;try{const result=await api('/api/ai/admin/credentials/rotate',{method:'POST'});toast(`密钥轮换完成：${Number(result.result?.rotatedCount||0)} 条`,'success');await loadPlatformModels()}catch(error){handleError(error);event.currentTarget.disabled=false}}
  document.querySelector('#clearLegacyCredentials').onclick=async event=>{if(!await confirmAction('清理旧明文凭证？','仅在所有迁移记录已验证后执行。清理后旧配置中的明文密钥无法恢复。','确认永久清理',true))return;event.currentTarget.disabled=true;try{await api('/api/ai/admin/credentials/finalize-legacy-cleanup',{method:'POST',body:JSON.stringify({confirm:'CLEAR_VERIFIED_LEGACY_CREDENTIALS'})});toast('旧明文凭证已清理','success');await loadPlatformModels()}catch(error){handleError(error);event.currentTarget.disabled=false}}
}
const ADMIN_STRATEGY_MEMORY_COMPRESSION_POLL_INTERVAL_MS = 2_000
const ADMIN_STRATEGY_MEMORY_COMPRESSION_TERMINAL_STATUSES = new Set(['succeeded','succeeded_noop','failed','stale','status_unknown'])
const ADMIN_STRATEGY_MEMORY_CONSISTENCY_TERMINAL_STATUSES = new Set(['succeeded','succeeded_noop','failed','stale','status_unknown'])
const ADMIN_STRATEGY_MEMORY_MARKDOWN_LABEL = '完整记忆库原文（Markdown）'
function adminStrategyMemoryCompressionTerminal(job){return ADMIN_STRATEGY_MEMORY_COMPRESSION_TERMINAL_STATUSES.has(String(job?.status||''))}
function adminStrategyMemoryCompressionActive(job){return Boolean(job&&!adminStrategyMemoryCompressionTerminal(job))}
function adminStrategyMemoryCompressionText(job){const status=String(job?.status||'status_unknown'),stage=String(job?.presentation_stage||status);if(status==='succeeded'){const source=Number(job.source_char_count),result=Number(job.result_char_count);return Number.isFinite(source)&&Number.isFinite(result)?`整理完成，${Math.trunc(source).toLocaleString('zh-CN')} → ${Math.trunc(result).toLocaleString('zh-CN')} 字`:'整理完成'}if(status==='succeeded_noop')return'整理完成，当前内容已足够精炼，无需修改';if(status==='failed')return'整理失败，原记忆已保留';if(status==='stale')return'已过期，原记忆已保留';if(status==='status_unknown')return'状态无法确认，原记忆已保留';return({queued:'等待整理',running:'正在整理记忆',validating:'正在校验并保存',applying:'正在校验并保存'})[stage]||'正在整理记忆'}
function adminStrategyMemoryCompressionActivity(active){if(!active)return'<span class="admin-realtime-dot" aria-hidden="true"></span>';const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;return`<span class="admin-realtime-status" data-state="${reduced?'pending':'waiting'}" aria-hidden="true"><span class="admin-realtime-dot"></span></span>`}
function adminStrategyMemoryConsistencyTerminal(job){return ADMIN_STRATEGY_MEMORY_CONSISTENCY_TERMINAL_STATUSES.has(String(job?.status||''))}
function adminStrategyMemoryConsistencyLabel(job){if(String(job?.last_error_code||'')==='model_input_limit_exceeded')return'当前模型容量不足，未完成一致性检查';return({queued:'等待一致性检查',leased:'正在核对策略一致性',succeeded:'一致性检查完成',succeeded_noop:'未发现策略冲突',failed:'一致性检查失败，记忆已保留',stale:'策略或记忆已变化，结果未应用',status_unknown:'检查状态未知，可重新检查'})[String(job?.status||'')]||'尚未检查一致性'}
function stopPlatformMemoryConsistencyPolling(){clearTimeout(state.platformMemoryConsistencyPollTimer);state.platformMemoryConsistencyPollTimer=null;state.platformMemoryConsistencyPollKey=null;state.platformMemoryConsistencyPollGeneration+=1;state.platformMemoryConsistencyPollInFlight=false}
function resumePlatformMemoryConsistencyPolling(){const key=state.platformMemoryConsistencyPollKey,job=state.platformMemoryConsistencyJob;if(document.hidden||!key||!job||adminStrategyMemoryConsistencyTerminal(job))return;const[strategyId,jobId]=key.split(':').map(Number);startPlatformMemoryConsistencyPolling(strategyId,job)}
async function loadPlatformMemoryPreview(strategyId){try{const data=await api(`/api/ai/strategy-memories/${strategyId}/preview`);const library=state.platformMemory?.detail?.library;if(Number(data.library_identity?.strategy_id||strategyId)!==Number(strategyId)||Number(data.library_identity?.version_no||library?.version_no||0)!==Number(library?.version_no||0)||String(data.library_identity?.content_hash||library?.content_hash||'')!==String(library?.content_hash||'')){throw new Error('strategy_memory_preview_version_mismatch')}state.platformMemoryPreview=data;state.platformMemoryPreviewError='';if(data.consistency_check)state.platformMemoryConsistencyJob=data.consistency_check;return data}catch(error){state.platformMemoryPreview=null;state.platformMemoryPreviewError=ADMIN_AI_ERROR_MESSAGES[error.code||error.message]||'预览暂不可用，请重试；原文仍可查看';return null}}
function startPlatformMemoryConsistencyPolling(strategyId,job){const jobId=Number(job?.id||job?.job_id||0);if(!Number.isInteger(jobId)||jobId<=0)return;stopPlatformMemoryConsistencyPolling();state.platformMemoryConsistencyJob={...job,id:jobId,strategy_id:Number(strategyId),status:job.status||'queued'};state.platformMemoryConsistencyPollKey=`${Number(strategyId)}:${jobId}`;const generation=state.platformMemoryConsistencyPollGeneration;const poll=async()=>{if(document.hidden||generation!==state.platformMemoryConsistencyPollGeneration||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;if(state.platformMemoryConsistencyPollInFlight)return;state.platformMemoryConsistencyPollInFlight=true;try{const data=await api(`/api/ai/strategy-memories/${strategyId}/consistency-checks/${jobId}`);if(generation!==state.platformMemoryConsistencyPollGeneration||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;state.platformMemoryConsistencyJob=data.job||data;if(adminStrategyMemoryConsistencyTerminal(state.platformMemoryConsistencyJob)){state.platformMemoryConsistencyPollKey=null;state.platformMemory.detail=await api(`/api/ai/strategy-memories/${strategyId}`);await loadPlatformMemoryPreview(strategyId);renderPlatformMemory();return}}catch(error){if(generation===state.platformMemoryConsistencyPollGeneration&&!document.hidden)state.platformMemoryConsistencyPollTimer=setTimeout(poll,ADMIN_STRATEGY_MEMORY_COMPRESSION_POLL_INTERVAL_MS);return}finally{if(generation===state.platformMemoryConsistencyPollGeneration)state.platformMemoryConsistencyPollInFlight=false}if(generation===state.platformMemoryConsistencyPollGeneration&&!document.hidden)state.platformMemoryConsistencyPollTimer=setTimeout(poll,ADMIN_STRATEGY_MEMORY_COMPRESSION_POLL_INTERVAL_MS)};void poll()}
function adminStrategyMemoryConflictBadge(stateName, count) {
  const labels = {
    attention_required: ['triangle-alert', '需要人工检查策略'],
    observing: ['eye', '观察中'],
    unverified: ['circle-help', '检查发现，等待复盘验证'],
    location_stale: ['map-pin-off', '位置已变化，待复核'],
    resolved: ['circle-check', '已处理'],
    dismissed: ['minus', '已忽略'],
    healthy: ['circle-check', '状态正常'],
  }
  const [icon, label] = labels[String(stateName || '')] || []
  if (!label) return ''
  const countLabel = Number(count || 0) > 0 ? ` · ${Number(count)} 项` : ''
  return `<div class="strategy-memory-preview-status is-${escapeHtml(stateName)}" role="status"><span aria-hidden="true"><i data-lucide="${icon}" size="14"></i></span><strong>${label}${countLabel}</strong></div>`
}
function adminStrategyMemoryPreviewMarkup(preview) {
  if (!preview) return `<div class="strategy-memory-preview-error" role="alert"><strong>预览暂不可用</strong><span>${escapeHtml(state.platformMemoryPreviewError || '请重试预览，原文仍可查看。')}</span><button class="text-button" type="button" data-platform-memory-mode="source">编辑原文</button></div>`
  if (!(preview.blocks || []).length) return '<div class="strategy-memory-preview-empty"><strong>尚无已沉淀经验</strong><span>确认日/月复盘后会形成第一版记忆。</span></div>'
  const blocks = (preview.blocks || []).filter(block => !state.platformMemoryConflictOnly || block.conflict_ids?.length || block.conflict_state)
  return `<div class="strategy-memory-preview-body">${blocks.map(block => {
    const conflictState = String(block.conflict_state || '')
     const tone = conflictState ? ` is-${escapeHtml(conflictState === 'location_stale' ? 'location-stale' : conflictState)}` : ''
    const conflicts = (block.conflicts || []).map(item => `<details class="strategy-memory-inline-conflict"><summary>${escapeHtml(item.summary || '策略冲突候选')} · ${Number(item.evidence_count || 0)}/${Number(item.alert_threshold || 3)}</summary><p>策略原文：${escapeHtml(item.strategy_excerpt || '-')}</p><p>记忆原文：${escapeHtml(item.memory_excerpt || '-')}</p>${item.suggested_change ? `<p>建议核对：${escapeHtml(item.suggested_change)}</p>` : ''}</details>`).join('')
    const badge = adminStrategyMemoryConflictBadge(conflictState, conflicts ? (block.conflicts || []).length : 0)
    return `<article class="strategy-memory-preview-block${tone}" data-memory-block-id="${escapeHtml(block.block_id || '')}">${badge}${block.html || ''}${conflicts}</article>`
  }).join('') || '<div class="strategy-memory-preview-empty"><span>当前版本没有可定位冲突。</span></div>'}</div>`
}
function renderPlatformMemoryCompressionStatus(job=state.platformMemoryCompressionJob){const node=document.querySelector('#platformStrategyMemoryCompressionStatus');const active=adminStrategyMemoryCompressionActive(job),dirtyTerminal=!active&&state.platformMemoryEditorDirty&&job;if(node){node.innerHTML=`${adminStrategyMemoryCompressionActivity(active)}<span>${escapeHtml(dirtyTerminal?'整理完成，刷新前请先处理未保存编辑':job?adminStrategyMemoryCompressionText(job):'已保存')}</span>`;node.dataset.status=job?.status||'idle';node.setAttribute('aria-live',active?'polite':'assertive')}const button=document.querySelector('[data-platform-memory-compress],[data-platform-memory-action="compress"]');if(button){button.disabled=active;button.textContent=active?'正在整理':'整理并压缩'}const save=document.querySelector('#platformStrategyMemoryEditor button[type="submit"],[data-platform-memory-action="save"]');if(save)save.disabled=active||!state.platformMemoryEditorDirty}
function stopPlatformMemoryCompressionPolling({clearJob=true}={}){clearTimeout(state.platformMemoryCompressionPollTimer);state.platformMemoryCompressionPollTimer=null;state.platformMemoryCompressionPollKey=null;state.platformMemoryCompressionPollGeneration+=1;state.platformMemoryCompressionPollInFlight=false;if(clearJob)state.platformMemoryCompressionJob=null}
function schedulePlatformMemoryCompressionPoll(strategyId,jobId,generation,delay=ADMIN_STRATEGY_MEMORY_COMPRESSION_POLL_INTERVAL_MS){clearTimeout(state.platformMemoryCompressionPollTimer);state.platformMemoryCompressionPollTimer=null;if(document.hidden||generation!==state.platformMemoryCompressionPollGeneration||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;state.platformMemoryCompressionPollTimer=setTimeout(()=>{state.platformMemoryCompressionPollTimer=null;void pollPlatformMemoryCompressionJob(strategyId,jobId,generation)},Math.max(0,Number(delay)||0))}
async function finishPlatformMemoryCompressionPolling(strategyId,generation){if(generation!==state.platformMemoryCompressionPollGeneration||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;try{const detail=await api(`/api/ai/strategy-memories/${strategyId}`);if(generation!==state.platformMemoryCompressionPollGeneration||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;state.platformMemory.detail=detail;await loadPlatformMemoryPreview(strategyId);const textarea=document.querySelector('#platformStrategyMemoryContent');const changed=state.platformMemoryEditorDirty||(textarea&&state.platformMemoryEditorBaseline!==null&&textarea.value!==state.platformMemoryEditorBaseline);state.platformMemoryEditorDirty=Boolean(changed);if(!changed){state.platformMemoryEditorBaseline=detail.library?.content_text||'';state.platformMemoryEditorStrategyId=Number(strategyId);renderPlatformMemory()}else{renderPlatformMemoryCompressionStatus(state.platformMemoryCompressionJob);toast('整理完成，刷新前请先处理未保存编辑','warning')}}catch(error){renderPlatformMemoryCompressionStatus(state.platformMemoryCompressionJob);handleError(error)}}
async function pollPlatformMemoryCompressionJob(strategyId,jobId,generation){if(generation!==state.platformMemoryCompressionPollGeneration||state.platformMemoryCompressionPollInFlight||document.hidden||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;state.platformMemoryCompressionPollInFlight=true;let terminal=false;try{const data=await api(`/api/ai/strategy-memories/${strategyId}/compression-jobs/${jobId}`);if(generation!==state.platformMemoryCompressionPollGeneration||Number(state.platformMemoryStrategyId)!==Number(strategyId))return;const job=data.job||data;if(Number(job.id)!==Number(jobId)||Number(job.strategy_id)!==Number(strategyId))return;state.platformMemoryCompressionJob=job;state.platformMemoryCompressionJobs[String(strategyId)]=job;renderPlatformMemoryCompressionStatus(job);terminal=adminStrategyMemoryCompressionTerminal(job);if(terminal){state.platformMemoryCompressionPollKey=null;await finishPlatformMemoryCompressionPolling(strategyId,generation);return}}catch(error){if(generation===state.platformMemoryCompressionPollGeneration&&!document.hidden)schedulePlatformMemoryCompressionPoll(strategyId,jobId,generation);return}finally{if(generation===state.platformMemoryCompressionPollGeneration)state.platformMemoryCompressionPollInFlight=false}if(!terminal)schedulePlatformMemoryCompressionPoll(strategyId,jobId,generation)}
function startPlatformMemoryCompressionPolling(strategyId,job){const jobId=Number(job?.id||job?.job_id||0);if(!Number.isInteger(jobId)||jobId<=0)throw new Error('strategy_memory_compression_job_not_found');stopPlatformMemoryCompressionPolling({clearJob:true});state.platformMemoryCompressionJob={...job,id:jobId,strategy_id:Number(strategyId),status:job.status||'queued'};state.platformMemoryCompressionJobs[String(strategyId)]=state.platformMemoryCompressionJob;state.platformMemoryCompressionPollKey=`${Number(strategyId)}:${jobId}`;const generation=state.platformMemoryCompressionPollGeneration;renderPlatformMemoryCompressionStatus(state.platformMemoryCompressionJob);if(!document.hidden)void pollPlatformMemoryCompressionJob(strategyId,jobId,generation)}
function resumePlatformMemoryCompressionPolling(){const key=state.platformMemoryCompressionPollKey,job=state.platformMemoryCompressionJob;if(!key||!job||adminStrategyMemoryCompressionTerminal(job)||document.hidden)return;const[strategyId,jobId]=key.split(':').map(Number);void pollPlatformMemoryCompressionJob(strategyId,jobId,state.platformMemoryCompressionPollGeneration)}
function pausePlatformMemoryCompressionPolling(){clearTimeout(state.platformMemoryCompressionPollTimer);state.platformMemoryCompressionPollTimer=null;state.platformMemoryCompressionPollGeneration+=1;state.platformMemoryCompressionPollInFlight=false;state.platformMemoryRequestSeq+=1}
if(!window.__aurumStrategyMemoryVisibilityBound){document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(state.platformMemoryCompressionPollTimer);clearTimeout(state.platformMemoryConsistencyPollTimer)}else{resumePlatformMemoryCompressionPolling();resumePlatformMemoryConsistencyPolling()}});window.__aurumStrategyMemoryVisibilityBound=true}
async function openPlatformReview(reviewId){
  const data=await api(`/api/ai/period-reviews/${reviewId}`),review=data.review||{},current=(review.versions||[]).find(item=>Number(item.id)===Number(review.current_version_id))||(review.versions||[]).at(-1),editable=Boolean(current)&&review.status!=='approved',stats=review.evidence?.statistics||{}
  openEntityModal({title:`${review.period_type==='monthly'?'月复盘':'日复盘'} · ${review.period_key||'周期未识别'}`,eyebrow:'平台复盘审核',content:`<section class="platform-review-detail"><div class="platform-review-metrics"><div><span>策略</span><strong>${escapeHtml(review.strategy_title||`策略 #${review.strategy_id}`)}</strong></div><div><span>交易笔数</span><strong>${Number(stats.trade_count||review.source_count||0)}</strong></div><div><span>净收益</span><strong>${Number(stats.net_profit||0).toFixed(2)}</strong></div><div><span>证据状态</span><strong>${review.evidence_status==='complete'?'完整':'待补全'}</strong></div></div>${current?`<label class="field"><span>结构化复盘内容</span><textarea class="input editor-textarea platform-review-editor" id="platformReviewContent" ${editable?'':'disabled'}>${escapeHtml(JSON.stringify(current.content||{},null,2))}</textarea><small class="helper">保留现有字段结构；保存时系统会再次校验内容完整性。</small></label>`:`<div class="empty-state">${review.status==='failed'?'复盘生成失败，可重试生成。':'复盘内容仍在准备中。'}</div>`}<div class="form-actions">${review.status==='failed'?'<button class="secondary-button" data-platform-review-retry type="button">重试生成</button>':''}${editable?'<button class="secondary-button" data-platform-review-revise type="button">标记需要修改</button><button class="secondary-button" data-platform-review-save type="button">保存内容</button><button class="primary-button" data-platform-review-approve type="button">确认并沉淀记忆</button>':'<span class="badge active">内容已锁定</span>'}</div></section>`})
  const root=document.querySelector('#entityModalBody')
  const refresh=async()=>{closeEntityModal();await loadPlatformMemory()}
  root.querySelector('[data-platform-review-retry]')?.addEventListener('click',async()=>{try{await api(`/api/ai/period-reviews/${review.id}/retry`,{method:'POST'});toast('复盘已进入重试队列','success');await refresh()}catch(error){handleError(error)}})
  root.querySelector('[data-platform-review-save]')?.addEventListener('click',async()=>{try{const content=JSON.parse(root.querySelector('#platformReviewContent').value);await api(`/api/ai/period-reviews/${review.id}/edit`,{method:'POST',body:JSON.stringify({content,expected_version_id:current.id,change_note:'管理员在统一后台修改平台周期复盘'})});toast('复盘内容已保存为新版本','success');await refresh()}catch(error){handleError(error)}})
  root.querySelector('[data-platform-review-revise]')?.addEventListener('click',async()=>{try{await api(`/api/ai/period-reviews/${review.id}/confirm`,{method:'POST',body:JSON.stringify({version_id:current.id,action:'needs_revision'})});toast('复盘已标记为需要修改','success');await refresh()}catch(error){handleError(error)}})
  root.querySelector('[data-platform-review-approve]')?.addEventListener('click',async()=>{if(!await confirmAction('确认平台复盘？','确认后内容将锁定，并进入平台记忆候选生成流程。','确认并沉淀'))return;try{await api(`/api/ai/period-reviews/${review.id}/confirm`,{method:'POST',body:JSON.stringify({version_id:current.id,action:'approve'})});toast('平台复盘已确认','success');await refresh()}catch(error){handleError(error)}})
}
// Preview-first platform memory console.
function renderPlatformMemory(){
  const content=document.querySelector('#aiOperationsContent');if(!content)return
  const data=state.platformMemory||{},strategies=data.strategies||[],detail=data.detail||{},library=detail.library||{},conflicts=detail.conflicts||[],selected=Number(state.platformMemoryStrategyId||0)
  if(!strategies.length){content.innerHTML='<section class="panel section-gap"><div class="empty-state">暂无可管理策略</div></section>';return}
  if(Number(state.platformMemoryEditorStrategyId)!==selected||state.platformMemoryEditorBaseline===null){state.platformMemoryEditorStrategyId=selected;state.platformMemoryEditorBaseline=library.content_text||'';state.platformMemoryEditorDirty=false;state.platformMemoryEditorDraft=null}
  const sourceMode=state.platformMemoryViewMode==='source',compressionJob=Number(state.platformMemoryCompressionJob?.strategy_id)===selected?state.platformMemoryCompressionJob:null,active=adminStrategyMemoryCompressionActive(compressionJob),currentLocation=item=>String(item.verification_status||'')==='matched'&&String(item.location_status||'')==='matched',alerts=conflicts.filter(item=>item.status==='attention_required'&&currentLocation(item)),observing=conflicts.filter(item=>item.status==='observing'&&currentLocation(item)),activeIds=new Set([...alerts,...observing].map(item=>Number(item.id))),inactiveConflicts=conflicts.filter(item=>!activeIds.has(Number(item.id))),stale=inactiveConflicts.filter(item=>String(item.verification_status||'')==='location_stale'),usage=Math.min(100,Math.round(Number(library.char_count||0)/Math.max(1,Number(library.capacity_chars||120000))*100)),options=strategies.map(item=>`<option value="${Number(item.strategy_id)}" ${Number(item.strategy_id)===selected?'selected':''}>${escapeHtml(item.title||`策略 #${item.strategy_id}`)} · ${item.strategy_scope==='platform'?'平台':'私有'}</option>`).join('')
  const conflictRows=[...alerts,...observing,...inactiveConflicts].map(item=>{const staleRow=String(item.verification_status||'')==='location_stale',inactive=['resolved','dismissed'].includes(String(item.status||''));const stateName=staleRow?'location_stale':item.status;const label=adminStrategyMemoryConflictBadge(stateName,stateName==='observing'?Number(item.evidence_count||0):0);const actionButtons=inactive||staleRow?`<button class="secondary-button" type="button" data-platform-memory-conflict="${Number(item.id)}" data-platform-memory-conflict-action="reopen">重新打开</button>`:`<button class="secondary-button" type="button" data-platform-memory-conflict="${Number(item.id)}" data-platform-memory-conflict-action="dismiss">忽略</button><button class="primary-button" type="button" data-platform-memory-conflict="${Number(item.id)}" data-platform-memory-conflict-action="resolve">已处理</button>`;return`<article class="strategy-memory-conflict is-${stateName==='location_stale'?'location-stale':stateName}"><div>${label}<strong>${escapeHtml(item.conflict_summary||'发现记忆与策略可能冲突')}</strong>${item.strategy_excerpt?`<p>策略原文：${escapeHtml(item.strategy_excerpt)}</p>`:''}${item.memory_excerpt?`<p>记忆原文：${escapeHtml(item.memory_excerpt)}</p>`:''}${item.suggested_change?`<p>建议核对：${escapeHtml(item.suggested_change)}</p>`:''}</div><div class="strategy-memory-row-actions">${actionButtons}</div></article>`}).join('')
  const consistencyLabel=adminStrategyMemoryConsistencyLabel(state.platformMemoryConsistencyJob)
  content.innerHTML=`<section class="ai-module-summary"><div><small>策略记忆库</small><strong>${strategies.length}</strong></div><div><small>需要人工检查策略</small><strong>${alerts.length}</strong></div><div><small>当前版本</small><strong>v${Number(library.version_no||0)}</strong></div><div><small>容量使用</small><strong>${Number(library.char_count||0).toLocaleString('zh-CN')} / ${Number(library.capacity_chars||120000).toLocaleString('zh-CN')}</strong></div></section><section class="panel section-gap strategy-memory-library strategy-memory-workspace"><header class="strategy-memory-toolbar"><label><span>选择策略</span><select id="platformStrategyMemorySelector">${options}</select></label><div class="strategy-memory-summary"><span><strong>v${Number(library.version_no||0)}</strong> 当前版本</span><span class="strategy-memory-health ${alerts.length?'danger':observing.length?'warning':'success'}"><strong>${alerts.length?`需要人工检查 ${alerts.length} 项`:observing.length?`观察中 ${observing.length} 项`:'状态正常'}</strong></span></div></header><div class="strategy-memory-layout"><section class="strategy-memory-document" aria-label="平台策略记忆 Markdown 文档"><header class="strategy-memory-document-heading"><div><span class="strategy-memory-kicker">平台策略 · 唯一完整记忆库</span><h2>策略记忆文档</h2><p>当前版本会完整传入平台分析与周期复盘。</p></div><span class="strategy-memory-version">v${Number(library.version_no||0)} · ${Number(library.char_count||0).toLocaleString('zh-CN')} 字</span></header><div class="strategy-memory-viewbar"><div class="strategy-memory-view-switch" role="tablist" aria-label="记忆库查看模式"><button type="button" role="tab" aria-selected="${!sourceMode}" data-platform-memory-mode="preview" class="${!sourceMode?'active':''}">阅读预览</button><button type="button" role="tab" aria-selected="${sourceMode}" data-platform-memory-mode="source" class="${sourceMode?'active':''}">编辑原文</button></div><div class="strategy-memory-view-tools">${!sourceMode?`<label class="strategy-memory-filter-toggle"><input type="checkbox" data-platform-memory-conflict-only ${state.platformMemoryConflictOnly?'checked':''}><span class="strategy-memory-filter-control" aria-hidden="true"><span></span></span><span class="strategy-memory-filter-label">只看冲突</span></label>`:''}</div></div>${!sourceMode&&state.platformMemoryEditorDirty?'<div class="strategy-memory-draft-notice" role="status">当前显示的是已保存版本预览；原文中还有未保存修改。</div>':''}<div class="strategy-memory-document-stage">${sourceMode?`<label class="strategy-memory-editor"><span>编辑完整记忆库原文</span><textarea id="platformStrategyMemoryContent" rows="22" spellcheck="false" aria-describedby="platformStrategyMemoryHelp">${escapeHtml(state.platformMemoryEditorDirty?(state.platformMemoryEditorDraft??library.content_text??''):(library.content_text||''))}</textarea><small id="platformStrategyMemoryHelp">这是平台策略唯一的完整 Markdown 记忆库。保存会形成可恢复的新版本；不保存不会写入服务端。</small></label>`:adminStrategyMemoryPreviewMarkup(state.platformMemoryPreview)}</div>${sourceMode?`<div class="strategy-memory-actions strategy-memory-editor-actions"><button class="secondary-button" type="button" data-platform-memory-action="cancel">取消编辑</button><button class="primary-button" data-platform-memory-action="save" type="button" ${!state.platformMemoryEditorDirty||active?'disabled':''}>保存新版本</button></div>`:''}${conflictRows?`<section class="strategy-memory-conflicts"><header><div><h3>策略冲突提醒</h3><p>同一冲突必须在至少 ${Number(library.conflict_alert_threshold||3)} 次不同且已确认的复盘中出现，才会要求人工检查策略。</p></div><span>${alerts.length} 项需处理 · ${observing.length} 项观察中 · ${stale.length} 项待复核</span></header>${conflictRows}</section>`:''}</section><aside class="strategy-memory-sidebar" aria-label="平台记忆库维护状态"><section class="strategy-memory-side-card"><header><div><span class="strategy-memory-side-kicker">维护状态</span><h3>容量</h3></div><strong>${usage}%</strong></header><div class="strategy-memory-capacity" aria-label="记忆库容量已使用 ${usage}%"><span style="width:${usage}%"></span></div><p>${Number(library.char_count||0).toLocaleString('zh-CN')} / ${Number(library.capacity_chars||120000).toLocaleString('zh-CN')} 字</p></section><section class="strategy-memory-side-card"><header><div><span class="strategy-memory-side-kicker">维护任务</span><h3>整理压缩</h3></div><span id="platformStrategyMemoryCompressionStatus" class="status-chip" role="status" aria-live="polite">${active?'正在整理':'已保存'}</span></header><p>整理期间不会覆盖未保存草稿。</p><button class="secondary-button" type="button" data-platform-memory-action="compress" ${active?'disabled':''}>${active?'正在整理':'整理并压缩'}</button></section><section class="strategy-memory-side-card"><header><div><span class="strategy-memory-side-kicker">维护检查</span><h3>一致性</h3></div><span class="strategy-memory-consistency-status" role="status" aria-live="polite">${escapeHtml(consistencyLabel)}</span></header><button class="secondary-button" type="button" data-platform-memory-action="consistency">重新检查</button></section><section class="strategy-memory-side-card strategy-memory-conflict-card"><header><div><span class="strategy-memory-side-kicker">人工处理</span><h3>冲突计数</h3></div>${adminStrategyMemoryConflictBadge(alerts.length?'attention_required':observing.length?'observing':'healthy')}</header><div class="strategy-memory-side-metrics"><div><span>需人工检查</span><strong>${alerts.length}</strong></div><div><span>观察中</span><strong>${observing.length}</strong></div><div><span>待复核</span><strong>${stale.length}</strong></div></div></section><details class="strategy-memory-revisions strategy-memory-side-card"><summary><span><i data-lucide="history" size="15"></i><strong>版本历史</strong></span><i data-lucide="chevron-down" size="15"></i></summary><ol>${(detail.revisions||[]).slice(0,20).map(item=>`<li><div><strong>版本 ${Number(item.version_no||0)}</strong><span>${escapeHtml(item.change_reason||'历史版本')} · ${escapeHtml(formatDate(item.created_at,true))}</span></div>${Number(item.version_no)!==Number(library.version_no)?`<button class="text-button" type="button" data-platform-memory-restore="${Number(item.id)}">恢复此版本</button>`:'<span class="status-chip success">当前</span>'}</li>`).join('')||'<li>尚无历史版本</li>'}</ol></details></aside></div></section>`
  renderIcons(content);renderPlatformMemoryCompressionStatus(compressionJob)
   document.querySelector('#platformStrategyMemoryContent')?.addEventListener('input',event=>{state.platformMemoryEditorDirty=event.currentTarget.value!==state.platformMemoryEditorBaseline;state.platformMemoryEditorDraft=event.currentTarget.value;const save=document.querySelector('[data-platform-memory-action="save"]');if(save)save.disabled=!state.platformMemoryEditorDirty||adminStrategyMemoryCompressionActive(state.platformMemoryCompressionJob)})
  document.querySelector('#platformStrategyMemorySelector')?.addEventListener('change',async event=>{const previousId=Number(state.platformMemoryStrategyId||selected),nextId=Number(event.target.value);if(state.platformMemoryEditorDirty){const confirmed=await confirmAction('放弃未保存的记忆原文？','切换策略会丢弃当前尚未保存的 Markdown 修改。','放弃并切换',true);if(!confirmed){event.target.value=String(previousId);return}}stopPlatformMemoryCompressionPolling({clearJob:true});stopPlatformMemoryConsistencyPolling();state.platformMemoryStrategyId=nextId;state.platformMemoryEditorBaseline=null;state.platformMemoryEditorStrategyId=null;state.platformMemoryEditorDirty=false;state.platformMemoryEditorDraft=null;state.platformMemoryViewMode='preview';state.platformMemoryPreview=null;try{const[detail,latestCompression,latestConsistency]=await Promise.all([api(`/api/ai/strategy-memories/${nextId}`),api(`/api/ai/strategy-memories/${nextId}/compression-jobs-latest`),api(`/api/ai/strategy-memories/${nextId}/consistency-checks/latest`).catch(()=>({job:null}))]);state.platformMemory.detail=detail;state.platformMemoryCompressionJob=latestCompression.job||null;state.platformMemoryConsistencyJob=latestConsistency.job||detail.consistency_check||null;await loadPlatformMemoryPreview(nextId);renderPlatformMemory();if(state.platformMemoryCompressionJob&&adminStrategyMemoryCompressionActive(state.platformMemoryCompressionJob))startPlatformMemoryCompressionPolling(nextId,state.platformMemoryCompressionJob);if(state.platformMemoryConsistencyJob&&!adminStrategyMemoryConsistencyTerminal(state.platformMemoryConsistencyJob))startPlatformMemoryConsistencyPolling(nextId,state.platformMemoryConsistencyJob)}catch(error){handleError(error)}})
  document.querySelectorAll('[data-platform-memory-mode]').forEach(button=>button.addEventListener('click',()=>{const next=button.dataset.platformMemoryMode==='source'?'source':'preview';if(next==='source'&&!state.platformMemoryEditorDirty)state.platformMemoryEditorDraft=library.content_text||'';state.platformMemoryViewMode=next;renderPlatformMemory()}))
  document.querySelector('[data-platform-memory-conflict-only]')?.addEventListener('change',event=>{state.platformMemoryConflictOnly=Boolean(event.currentTarget.checked);renderPlatformMemory()})
  document.querySelectorAll('[data-platform-memory-conflict]').forEach(button=>button.addEventListener('click',async()=>{const conflictId=Number(button.dataset.platformMemoryConflict),action=button.dataset.platformMemoryConflictAction,current=conflicts.find(item=>Number(item.id)===conflictId);if(!conflictId||!action)return;button.disabled=true;try{await api(`/api/ai/strategy-memory-conflicts/${conflictId}/${action}`,{method:'POST',body:JSON.stringify({expected_updated_at:current?.updated_at})});toast(action==='resolve'?'冲突已标记为人工处理':action==='dismiss'?'冲突提醒已忽略':'冲突已重新打开','success');state.platformMemory.detail=await api(`/api/ai/strategy-memories/${selected}`);await loadPlatformMemoryPreview(selected);renderPlatformMemory()}catch(error){handleError(error)}finally{button.disabled=false}}))
  document.querySelectorAll('[data-platform-memory-action]').forEach(button=>button.addEventListener('click',async()=>{const action=button.dataset.platformMemoryAction;if(!selected||!library)return;if(action==='consistency'){button.disabled=true;try{const queued=await api(`/api/ai/strategy-memories/${selected}/consistency-checks`,{method:'POST',body:JSON.stringify({expected_version_no:Number(library.version_no),trigger_type:'manual_check',force_new:['stale','status_unknown','failed'].includes(String(state.platformMemoryConsistencyJob?.status||''))})});startPlatformMemoryConsistencyPolling(selected,queued.job||queued);toast('一致性检查已进入队列','success')}catch(error){handleError(error)}finally{button.disabled=false}return}if(action==='compress'){if(active)return;button.disabled=true;try{const queued=await api(`/api/ai/strategy-memories/${selected}/compress`,{method:'POST'});startPlatformMemoryCompressionPolling(selected,queued.job||queued);toast('整理任务已进入队列','success')}catch(error){handleError(error)}finally{button.disabled=false}return}if(action==='save'){if(active||state.platformMemoryViewMode!=='source')return;const text=document.querySelector('#platformStrategyMemoryContent')?.value||'';button.disabled=true;try{const data=await api(`/api/ai/strategy-memories/${selected}`,{method:'PUT',body:JSON.stringify({content_text:text,expected_version_no:Number(library.version_no),capacity_chars:Number(library.capacity_chars||120000),compression_target_ratio:Number(library.compression_target_ratio||.6),conflict_alert_threshold:Number(library.conflict_alert_threshold||3)})});toast(`策略记忆库已保存为版本 ${Number(data.library?.version_no||0)}`,'success');state.platformMemoryEditorDirty=false;state.platformMemoryEditorBaseline=data.library?.content_text||text;state.platformMemoryEditorDraft=null;state.platformMemoryViewMode='preview';state.platformMemory.detail=await api(`/api/ai/strategy-memories/${selected}`);await loadPlatformMemoryPreview(selected);renderPlatformMemory();if(Number(data.compression_job_id||data.library?.compression_job_id||0)>0)startPlatformMemoryCompressionPolling(selected,{id:Number(data.compression_job_id||data.library?.compression_job_id),status:'queued'});if(Number(data.consistency_job_id||0)>0)startPlatformMemoryConsistencyPolling(selected,{id:Number(data.consistency_job_id),status:'queued'})}catch(error){handleError(error)}finally{button.disabled=false}}}))
}

async function loadPlatformMemory(){const requestSeq=++state.platformMemoryRequestSeq;const[ data,reviews ]=await Promise.all([api('/api/ai/strategy-memories'),api('/api/ai/period-reviews?limit=50')]);if(requestSeq!==state.platformMemoryRequestSeq||state.view!=='ai-operations'||state.aiTab!=='memory')return;const previous=state.platformMemory||{};state.platformMemory={...previous,strategies:data.strategies||[],reviews:reviews.cases||[]};const currentIds=new Set((data.strategies||[]).map(item=>Number(item.strategy_id)));if(!currentIds.has(Number(state.platformMemoryStrategyId)))state.platformMemoryStrategyId=Number(data.strategies?.[0]?.strategy_id||0)||null;if(state.platformMemoryStrategyId){const[detail,latestCompression,latestConsistency]=await Promise.all([api(`/api/ai/strategy-memories/${state.platformMemoryStrategyId}`),api(`/api/ai/strategy-memories/${state.platformMemoryStrategyId}/compression-jobs-latest`),api(`/api/ai/strategy-memories/${state.platformMemoryStrategyId}/consistency-checks/latest`).catch(()=>({job:null}))]);state.platformMemory.detail=detail;state.platformMemoryCompressionJob=latestCompression.job||null;state.platformMemoryConsistencyJob=latestConsistency.job||detail.consistency_check||null;await loadPlatformMemoryPreview(state.platformMemoryStrategyId)}else{state.platformMemory.detail=null;state.platformMemoryPreview=null;state.platformMemoryCompressionJob=null;state.platformMemoryConsistencyJob=null}if(requestSeq!==state.platformMemoryRequestSeq||state.view!=='ai-operations'||state.aiTab!=='memory')return;renderPlatformMemory();const remembered=state.platformMemoryCompressionJob;if(remembered&&adminStrategyMemoryCompressionActive(remembered))startPlatformMemoryCompressionPolling(state.platformMemoryStrategyId,remembered);const consistency=state.platformMemoryConsistencyJob;if(consistency&&!adminStrategyMemoryConsistencyTerminal(consistency))startPlatformMemoryConsistencyPolling(state.platformMemoryStrategyId,consistency)}

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
  const online=sources.filter(source=>source.bridge_online).length,auto=sources.filter(source=>Number(source.auto_inference_enabled)).length,available=channels.filter(channel=>channel.status==='active'&&channel.source_status==='active').length
  return `<section class="ai-module-summary"><div><small>观摩来源</small><strong>${sources.length}</strong></div><div><small>桥接在线</small><strong>${online}</strong></div><div><small>自动分析</small><strong>${auto}</strong></div><div><small>可用频道</small><strong>${available}</strong></div></section><section class="observer-admin-grid"><article class="panel"><header class="section-head"><div><h2>观摩源</h2><p>管理来源账号、固定策略和运行控制。</p></div><button class="secondary-button" data-new-observer-source type="button">新增来源</button></header><div class="observer-stack">${sources.length ? sources.map(source => `<article class="observer-source-row"><div class="observer-source-title"><span class="provider-dot ${source.bridge_online ? 'ok' : ''}"></span><div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.strategy_title || '未绑定策略')} · ${source.bridge_online ? '桥接在线' : '桥接离线'}</small></div></div><div class="runtime-switches"><label><input type="checkbox" data-source-toggle="auto" data-source-id="${Number(source.id)}" ${Number(source.auto_inference_enabled) ? 'checked' : ''}><span>自动分析</span></label><label><input type="checkbox" data-source-toggle="trade" data-source-id="${Number(source.id)}" ${Number(source.trade_send_enabled) ? 'checked' : ''}><span>交易发送</span></label><button class="icon-button compact-icon" data-edit-observer-source="${Number(source.id)}" type="button" aria-label="编辑观摩源 ${escapeHtml(source.name)}"><span data-icon="more"></span></button></div></article>`).join('') : '<div class="empty-state">还没有配置观摩源</div>'}</div></article>
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
  stopAiSchedulerTicker()
  content.dataset.aiPanel = state.aiTab
  if (state.aiTab === 'model-compare') {
    renderModelCompareContent()
    if (!state.modelCompare.setup) loadModelCompareWorkspace().catch(handleError)
    syncAiTabs()
    return
  }
  if (state.aiTab === 'governance') {
    renderAiGovernanceContent()
    if (!state.aiGovernance) loadAiGovernance().catch(handleError)
    syncAiTabs()
    return
  }
  if (state.aiTab === 'memory') {
    clearTimeout(state.modelCompare.polling)
    state.modelCompare.polling = null
    if (!state.platformMemory) {
      content.innerHTML = '<div class="panel"><div class="empty-state">正在读取统一策略记忆…</div></div>'
      loadPlatformMemory().catch(handleError)
    } else {
      renderPlatformMemory()
      resumePlatformMemoryCompressionPolling()
    }
    syncAiTabs()
    return
  }
  clearTimeout(state.modelCompare.polling)
  state.modelCompare.polling = null
  if (!state.aiOperations) return
  if (state.aiTab === 'scheduler') content.innerHTML = aiSchedulerContent(state.aiOperations)
  else if (state.aiTab === 'observer') content.innerHTML = aiObserverContent(state.aiOperations)
  else content.innerHTML = aiHealthContent(state.aiOperations)
  renderIcons(content)
  bindAiJumpActions(content)
  syncAiTabs()
  if (state.aiTab === 'observer') bindObserverRuntime()
  if (state.aiTab === 'scheduler') startAiSchedulerTicker()
}
async function loadAiOperations(silent = false) {
  const requestSeq = ++state.realtime.aiOperationsRequestSeq
  state.realtime.aiOperationsAbortController?.abort()
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  state.realtime.aiOperationsAbortController = controller
  if (!silent) document.querySelector('#aiOperationsContent').innerHTML = '<div class="panel"><div class="empty-state">正在汇总 AI 运行数据…</div></div>'
  try {
    const data = controller
      ? await api('/api/admin/ai/overview', { signal:controller.signal })
      : await api('/api/admin/ai/overview')
    if (requestSeq !== state.realtime.aiOperationsRequestSeq) return
    state.aiOperations = data.operations
    const clock = data.operations?.mt5_clock || {}
    const summary = data.operations?.summary || {}
    const connectedMt4 = Number(summary.connected_mt4_bridges || 0)
    const connectedMt5 = Number(summary.connected_mt5_bridges || 0)
    const connectedPlatform = clock.platform || (connectedMt4 > 0 && connectedMt5 === 0 ? 'mt4' : connectedMt5 > 0 && connectedMt4 === 0 ? 'mt5' : '')
    updateAiOpsTerminalClock(clock.time, clock.user_id, connectedPlatform, clock.timezone_offset_minutes)
    renderAiOperationsContent()
  } catch (error) {
    if (error?.name === 'AbortError' || requestSeq !== state.realtime.aiOperationsRequestSeq) return
    throw error
  } finally {
    if (requestSeq === state.realtime.aiOperationsRequestSeq) state.realtime.aiOperationsAbortController = null
  }
}
function positionManagementModeLabel(mode) {
  return ['auto_exit','auto_reverse'].includes(mode)?'已开启':'已关闭'
}
const riskRuleLabels={
  data_complete:'数据完整性',entitlement:'会员与权限',idempotency:'防重复执行',kill_switch:'紧急停止',ownership:'账户归属',volume_bounds:'手数边界',
  'R1.1_SYMBOL_NOT_ALLOWED':'品种未授权','R2.2_MIN_OPEN_INTERVAL':'最小开仓间隔','R2.3_DAILY_OPEN_COUNT':'每日开仓次数','R2.4_PRICE_TIME_DUPLICATE':'重复订单',
  'R3.1_DAILY_LOSS_LIMIT':'每日亏损上限','R3.2_CONSECUTIVE_LOSS_COOLDOWN':'连续亏损冷却','R3.2_LOSS_COOLDOWN':'亏损冷却','R3.3_MAX_DRAWDOWN':'最大回撤',
  'R4.2_WEEKEND_PROTECTION':'周末保护','R4.3_SIGNAL_EXPIRED':'信号过期','R4.4_QUOTE_STALE':'报价过期','R4.5_SPREAD_TOO_WIDE':'点差过大','R4.6_EXECUTION_PRICE_DEVIATION':'执行价格偏差',
}
function riskRuleLabel(code){return riskRuleLabels[code]||'平台风控规则'}
function positionManagementErrorMessage(error) {
  const messages={
    position_management_auto_reverse_not_ready:'当前仅支持“关闭”和“自动平仓”。',
    position_management_enable_reason_required:'启用正式执行时，请填写不少于 4 个字的变更原因。',
  }
  return messages[error?.message]||error?.message||'持仓管理配置保存失败'
}
function positionManagementGovernance(position={}) {
  const platform=position.platform||{}
  const worker=position.worker||{}
  const controls=[
    {id:'positionAutoExit',label:'自动平仓',description:'允许 AI 在退出证据充分且安全核对通过后平仓；不影响挂单取消。',checked:platform.maximum_mode==='auto_exit',tone:'critical'},
    {id:'positionAiPendingOrder',label:'AI 挂单',description:'允许 AI 新增限价、止损及止损限价挂单；不影响市价单。',checked:Number(platform.ai_pending_order_enabled ?? 1)},
    {id:'positionAiPendingCancel',label:'AI 取消挂单',description:'允许 AI 在归属与终态核对通过后取消策略挂单；不受平仓总闸影响。',checked:Number(platform.ai_pending_cancel_enabled ?? 1)},
  ]
  return `<section class="panel governance-card governance-execution-panel">
    <header class="governance-card-head">
      <div class="governance-card-heading"><span class="governance-step">02</span><div><span class="eyebrow">AI 交易执行</span><h2>平台能力总控</h2><p>分别控制自动平仓、新增 AI 挂单和 AI 取消挂单，三项能力互不联动；平台总控不会改写用户已保存的个人选择。</p></div></div>
      <span class="governance-state-pill ${worker.timer_active?'is-ready':'is-danger'}"><i></i>${worker.timer_active?'工作器运行中':'工作器未运行'}</span>
    </header>
    <form id="positionControlForm" class="governance-execution-form">
      <div class="governance-execution-grid">${controls.map(item=>`<label class="governance-capability ${item.tone==='critical'?'is-critical':''}" for="${item.id}"><span class="governance-capability-icon" data-icon="${item.tone==='critical'?'shield':item.id==='positionAiPendingOrder'?'plus':'check'}" aria-hidden="true"></span><span class="governance-capability-copy"><strong>${item.label}</strong><small>${item.description}</small><em>${item.checked?'当前已开启':'当前已关闭'}</em></span><span class="governance-switch"><input id="${item.id}" type="checkbox" ${item.checked?'checked':''}><span aria-hidden="true"><i></i></span></span></label>`).join('')}</div>
      <div class="governance-change-row">
        <label class="field governance-reason-field" for="positionControlReason"><span>变更原因</span><input class="input" id="positionControlReason" maxlength="1000" value="${escapeHtml(platform.reason||'')}" placeholder="说明本次调整目的，开启自动平仓时至少填写 4 个字"><small>变更会写入管理审计；关闭平台总控不会改变用户个人开关。</small></label>
        <div class="governance-save-cluster"><div class="governance-save-state" id="positionControlDirty"><span></span><div><strong>配置已同步</strong><small>修改后再保存</small></div></div><button class="primary-button" id="positionControlSave" type="submit" disabled><span data-icon="save" aria-hidden="true"></span>保存执行能力</button></div>
      </div>
    </form>
  </section>`
}
function aiGovernanceContent() {
  const data=state.aiGovernance
  if(!data)return '<div class="panel"><div class="empty-state">正在读取平台治理配置…</div></div>'
  const profiles=data.profiles||[],policy=data.policy||{},health=data.health||{},position=data.position||{}
  const globalFlags=(health.feature_flags||[]).find(item=>item.scope==='global')||{}
  const rollouts=health.risk_rule_rollouts||[],defaultModel=profiles.find(item=>Number(item.is_default))||profiles[0]
  const platform=position.platform||{},capabilities=position.capabilities||{}
  const allowedPlans=safeJson(policy.allowed_plans,['pro'])
  const activeProfiles=profiles.filter(item=>item.status==='active').length
  const enforcedRollouts=rollouts.filter(item=>item.mode==='enforce').length
  const shadowRollouts=rollouts.filter(item=>item.mode==='shadow').length
  const permissionItems=[['share_for_manual','手动分析','用户主动发起分析'],['share_for_auto','自动推理','调度器自动调用模型'],['share_for_review','复盘生成','生成日复盘与月复盘'],['share_for_memory_compression','记忆压缩','摘要长期经验记忆']]
  const readinessItems=[
    ['自动平仓',positionManagementModeLabel(platform.maximum_mode),platform.maximum_mode==='auto_exit'],
    ['AI 挂单',Number(platform.ai_pending_order_enabled ?? 1)?'已开启':'已关闭',Number(platform.ai_pending_order_enabled ?? 1)],
    ['AI 取消挂单',Number(platform.ai_pending_cancel_enabled ?? 1)?'已开启':'已关闭',Number(platform.ai_pending_cancel_enabled ?? 1)],
    ['安全执行工作器',capabilities.worker_installed?'已接入':'未接入',capabilities.worker_installed],
    ['取消挂单终态核对',capabilities.pending_cancel_ready?'已接入':'未接入',capabilities.pending_cancel_ready],
  ]
  const credentialStatus=health.credential_migration?.status==='succeeded'?'已完成':health.credential_migration?.status==='failed'?'失败':'尚未执行'
  return `<section class="governance-status-strip" aria-label="平台治理态势">
    <article class="governance-status-card"><span class="governance-status-icon" data-icon="settings" aria-hidden="true"></span><div><span>默认平台模型</span><strong>${escapeHtml(defaultModel?.model_name||'未配置')}</strong><small>${activeProfiles} 个模型当前可用</small></div><em class="${defaultModel?'is-ready':'is-danger'}"><i></i>${defaultModel?'已配置':'待配置'}</em></article>
    <article class="governance-status-card"><span class="governance-status-icon" data-icon="activity" aria-hidden="true"></span><div><span>共享自动推理</span><strong>${Number(policy.share_for_auto)?'已开放':'未开放'}</strong><small>每用户每日 ${Number(policy.daily_requests_per_user||0).toLocaleString('zh-CN')} 次</small></div><em class="${Number(policy.share_for_auto)?'is-ready':'is-muted'}"><i></i>${Number(policy.share_for_auto)?'运行中':'已限制'}</em></article>
    <article class="governance-status-card"><span class="governance-status-icon" data-icon="shield" aria-hidden="true"></span><div><span>AI 执行链路</span><strong>${positionManagementModeLabel(platform.maximum_mode)}</strong><small>${capabilities.automatic_execution_ready?'安全执行链路已就绪':'自动执行器未就绪'}</small></div><em class="${capabilities.automatic_execution_ready?'is-ready':'is-danger'}"><i></i>${capabilities.automatic_execution_ready?'可执行':'需处理'}</em></article>
    <article class="governance-status-card"><span class="governance-status-icon" data-icon="chart" aria-hidden="true"></span><div><span>风控规则运行态</span><strong>${enforcedRollouts} / ${rollouts.length}</strong><small>${shadowRollouts} 条处于影子评估</small></div><em class="${shadowRollouts?'is-warning':'is-ready'}"><i></i>${shadowRollouts?'含灰度':'全量执行'}</em></article>
  </section>
  <section class="governance-primary-grid">
    <article class="panel governance-card governance-access-panel">
      <header class="governance-card-head"><div class="governance-card-heading"><span class="governance-step">01</span><div><span class="eyebrow">平台模型权限</span><h2>共享范围与用量边界</h2><p>只管理平台模型的调用权限；策略、模型资产与复盘内容仍在 AI 交易实验室维护。</p></div></div><span class="governance-card-meta">${allowedPlans.length} 类会员可用</span></header>
      <form id="aiGovernancePolicy" class="governance-policy-form">
        <fieldset class="governance-fieldset"><legend>允许使用平台模型的任务</legend><div class="governance-permission-grid">${permissionItems.map(([key,label,description])=>`<label class="governance-permission" for="governance-${key}"><span><strong>${label}</strong><small>${description}</small></span><span class="governance-switch"><input id="governance-${key}" type="checkbox" data-governance-policy="${key}" ${Number(policy[key])?'checked':''}><span aria-hidden="true"><i></i></span></span></label>`).join('')}</div></fieldset>
        <div class="governance-policy-boundaries">
          <fieldset class="governance-fieldset governance-plan-fieldset"><legend>允许会员</legend><div class="governance-plan-options"><label><input type="checkbox" data-governance-plan value="plus" ${allowedPlans.includes('plus')?'checked':''}><span>Plus 用户</span></label><label><input type="checkbox" data-governance-plan value="pro" ${allowedPlans.includes('pro')?'checked':''}><span>Pro 用户</span></label></div></fieldset>
          <label class="field governance-number-field" for="governanceRequests"><span>每日请求 / 用户</span><div><input class="input" id="governanceRequests" type="number" min="1" value="${Number(policy.daily_requests_per_user||100)}"><em>次</em></div><small>按自然日重置</small></label>
          <label class="field governance-number-field" for="governanceTokens"><span>每日令牌告警阈值 / 用户</span><div><input class="input" id="governanceTokens" type="number" min="1000" step="1000" value="${Number(policy.daily_tokens_per_user||500000)}"><em>令牌</em></div><small>仅统计和告警，不阻止共享任务</small></label>
        </div>
        <footer class="governance-card-footer"><div class="governance-save-state" id="governancePolicyDirty"><span></span><div><strong>权限配置已同步</strong><small>修改后再保存</small></div></div><button class="primary-button" id="governancePolicySave" type="submit" disabled><span data-icon="save" aria-hidden="true"></span>保存权限配置</button></footer>
      </form>
    </article>
    <aside class="panel governance-card governance-readiness-panel">
      <header class="governance-card-head governance-compact-head"><div><span class="eyebrow">执行健康</span><h2>安全链路</h2><p>执行前置能力与平台开关的当前状态。</p></div><span class="governance-state-pill ${capabilities.automatic_execution_ready?'is-ready':'is-danger'}"><i></i>${capabilities.automatic_execution_ready?'链路就绪':'链路异常'}</span></header>
      <div class="governance-readiness-list">${readinessItems.map(([label,value,ready])=>`<div><span><i class="${ready?'is-ready':'is-muted'}">${ready?'<span data-icon="check" aria-hidden="true"></span>':'—'}</i>${label}</span><strong class="${ready?'is-ready':'is-muted'}">${value}</strong></div>`).join('')}</div>
      <div class="governance-readiness-note"><span data-icon="shield" aria-hidden="true"></span><p>${escapeHtml(capabilities.reason||'三项 AI 执行能力均使用独立平台开关与对应安全链路。')}</p></div>
    </aside>
  </section>
  ${positionManagementGovernance(position)}
  <section class="panel governance-card governance-rules-panel">
    <header class="governance-card-head"><div class="governance-card-heading"><span class="governance-step">03</span><div><span class="eyebrow">功能与风控</span><h2>平台规则矩阵</h2><p>强制规则始终正式执行；可灰度规则的模式调整会单项即时生效。</p></div></div><button class="secondary-button governance-refresh-button" id="refreshAiGovernanceCompact" type="button"><span data-icon="refresh" aria-hidden="true"></span>刷新状态</button></header>
    <div class="governance-rules-layout">
      <div class="governance-feature-column">
        <form id="aiGovernanceFeatures" class="governance-feature-form"><div class="governance-subhead"><div><span>功能总控</span><strong>AI 辅助能力</strong></div><em>${Object.keys(featureLabels).filter(key=>globalFlags[key]).length} 项开启</em></div><div class="governance-feature-list">${Object.entries(featureLabels).map(([key,[label,description]])=>`<label for="governance-feature-${key}"><span><strong>${label}</strong><small>${description}</small></span><span class="governance-switch"><input id="governance-feature-${key}" type="checkbox" data-governance-feature="${key}" ${globalFlags[key]?'checked':''}><span aria-hidden="true"><i></i></span></span></label>`).join('')}</div><footer><div class="governance-save-state" id="governanceFeatureDirty"><span></span><div><strong>功能配置已同步</strong><small>修改后再保存</small></div></div><button class="secondary-button" id="saveAiGovernanceFeatures" type="submit" disabled><span data-icon="save" aria-hidden="true"></span>保存功能开关</button></footer></form>
        <section class="governance-credential-tool"><div class="governance-credential-icon" data-icon="key" aria-hidden="true"></div><div><span>模型凭证</span><strong>${credentialStatus}</strong><small>最近轮换：${escapeHtml(formatDate(health.credential_migration?.completed_at||health.credential_migration?.started_at,true))}</small></div><button class="secondary-button" id="rotateGovernanceCredentials" type="button"><span data-icon="rotate" aria-hidden="true"></span>重新加密</button></section>
      </div>
      <section class="governance-rollout-column"><div class="governance-subhead"><div><span>风险规则</span><strong>执行与灰度状态</strong></div><div class="governance-rollout-summary"><span><i class="is-ready"></i>${enforcedRollouts} 正式执行</span><span><i class="is-warning"></i>${shadowRollouts} 影子评估</span></div></div><div class="governance-rollout-head" aria-hidden="true"><span>规则</span><span>控制边界</span><span>运行模式</span></div><div class="rollout-list governance-rollout-list">${rollouts.map(item=>`<label><span class="governance-rule-name"><i class="${item.mode==='shadow'?'is-warning':'is-ready'}"></i><strong>${escapeHtml(riskRuleLabel(item.rule_code))}</strong><small>${escapeHtml(item.rule_code)}</small></span><span class="governance-rule-lock ${Number(item.forced_enforce)?'is-forced':''}">${Number(item.forced_enforce)?'系统强制':'允许灰度'}</span><select class="select" aria-label="${escapeHtml(riskRuleLabel(item.rule_code))}运行模式" data-governance-rollout="${escapeHtml(item.rule_code)}" ${Number(item.forced_enforce)?'disabled':''}><option value="enforce" ${item.mode!=='shadow'?'selected':''}>正式执行</option><option value="shadow" ${item.mode==='shadow'?'selected':''}>影子评估</option></select></label>`).join('')||'<div class="empty-inline">暂无规则灰度记录</div>'}</div></section>
    </div>
  </section>`
}
async function loadAiGovernance(){
  const [profiles,policy,health,position]=await Promise.all([api('/api/ai/model-profiles?scope=platform'),api('/api/ai/platform-model-policy'),api('/api/ai/admin/rollout-health'),api('/api/ai/admin/position-management-settings')])
  state.aiGovernance={profiles:profiles.profiles||[],policy:policy.policy||{},health:health.health||{},position}
  renderAiGovernanceContent()
}
function renderAiGovernanceContent(){
  const content=document.querySelector('#aiOperationsContent');if(!content)return
  const platform=state.aiGovernance?.position?.platform||{}
  content.innerHTML=aiGovernanceContent();renderIcons(content);syncAiTabs()
  const bindDirtyState=(root,statusId,buttonId,dirtyTitle)=>{const status=content.querySelector(`#${statusId}`),button=content.querySelector(`#${buttonId}`);if(!root||!status||!button)return;const mark=()=>{status.classList.add('is-dirty');status.querySelector('strong').textContent=dirtyTitle;status.querySelector('small').textContent='保存后立即生效';button.disabled=false};root.addEventListener('input',mark);root.addEventListener('change',mark)}
  const policyForm=content.querySelector('#aiGovernancePolicy')
  const positionForm=content.querySelector('#positionControlForm')
  const featureForm=content.querySelector('#aiGovernanceFeatures')
  bindDirtyState(policyForm,'governancePolicyDirty','governancePolicySave','权限配置有修改')
  bindDirtyState(positionForm,'positionControlDirty','positionControlSave','执行能力有修改')
  bindDirtyState(featureForm,'governanceFeatureDirty','saveAiGovernanceFeatures','功能开关有修改')
  positionForm?.querySelectorAll('.governance-capability input').forEach(input=>input.addEventListener('change',()=>{const label=input.closest('.governance-capability')?.querySelector('.governance-capability-copy em');if(label)label.textContent=`待保存：将${input.checked?'开启':'关闭'}`}))
  policyForm?.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,payload={allowed_plans:[...content.querySelectorAll('[data-governance-plan]:checked')].map(input=>input.value),daily_requests_per_user:Number(content.querySelector('#governanceRequests').value),daily_tokens_per_user:Number(content.querySelector('#governanceTokens').value)};content.querySelectorAll('[data-governance-policy]').forEach(input=>payload[input.dataset.governancePolicy]=input.checked);button.disabled=true;try{await api('/api/ai/platform-model-policy',{method:'PUT',body:JSON.stringify(payload)});toast('平台模型权限已保存','success');await loadAiGovernance()}catch(error){handleError(error);button.disabled=false}})
  positionForm?.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,mode=content.querySelector('#positionAutoExit').checked?'auto_exit':'display',payload={maximum_mode:mode,ai_pending_order_enabled:content.querySelector('#positionAiPendingOrder').checked,ai_pending_cancel_enabled:content.querySelector('#positionAiPendingCancel').checked,reason:content.querySelector('#positionControlReason').value.trim()},enabling=[];if(mode==='auto_exit'&&platform.maximum_mode!=='auto_exit')enabling.push('自动平仓');if(payload.ai_pending_order_enabled&&!Number(platform.ai_pending_order_enabled))enabling.push('AI 挂单');if(payload.ai_pending_cancel_enabled&&!Number(platform.ai_pending_cancel_enabled))enabling.push('AI 取消挂单');if(enabling.length&&!await confirmAction('开启平台 AI 执行能力？',`将开启：${enabling.join('、')}。每项能力仍须通过对应的风控、归属和 MT5 前置核对。`,'确认开启'))return;button.disabled=true;try{await api('/api/ai/admin/position-management-control',{method:'PUT',body:JSON.stringify(payload)});toast('AI 交易执行平台能力已保存','success');await loadAiGovernance()}catch(error){toast(positionManagementErrorMessage(error),'error');button.disabled=false}})
  featureForm?.addEventListener('submit',async event=>{event.preventDefault();const flags={};content.querySelectorAll('[data-governance-feature]').forEach(input=>flags[input.dataset.governanceFeature]=input.checked);event.submitter.disabled=true;try{await api('/api/ai/admin/feature-flags',{method:'PUT',body:JSON.stringify({flags})});toast('AI 功能开关已保存','success');await loadAiGovernance()}catch(error){handleError(error);event.submitter.disabled=false}})
  content.querySelectorAll('[data-governance-rollout]').forEach(select=>select.addEventListener('change',async()=>{select.disabled=true;try{await api(`/api/ai/admin/risk-rule-rollouts/${encodeURIComponent(select.dataset.governanceRollout)}`,{method:'PUT',body:JSON.stringify({mode:select.value})});toast('规则运行模式已更新','success')}catch(error){handleError(error);await loadAiGovernance()}finally{select.disabled=false}}))
  content.querySelector('#refreshAiGovernanceCompact')?.addEventListener('click',()=>loadAiGovernance().catch(handleError))
  content.querySelector('#rotateGovernanceCredentials')?.addEventListener('click',async event=>{if(!await confirmAction('重新加密模型密钥？','系统会使用当前主密钥轮换平台模型凭证，已有请求不受影响。','确认轮换'))return;event.currentTarget.disabled=true;try{const result=await api('/api/ai/admin/credentials/rotate',{method:'POST'});toast(`密钥轮换完成：${Number(result.result?.rotatedCount||0)} 条`,'success');await loadAiGovernance()}catch(error){handleError(error);event.currentTarget.disabled=false}})
}
async function renderAiOperations() {
  const main = document.querySelector('#adminMain')
  const realtimeLive = state.realtime.ws?.readyState === WebSocket.OPEN
  const terminalTime = formatTerminalTime(state.realtime.terminalTime)
  const terminalLabel = terminalPlatformLabel()
  main.innerHTML = `<header class="ai-ops-masthead"><div class="ai-ops-title-lockup"><span class="ai-ops-title-icon" data-icon="activity" aria-hidden="true"></span><div><span class="eyebrow">智能交易运营中枢</span><h1>AI 运营</h1><p>集中查看运行健康、自动调度、观摩分发、模型评测与平台治理。</p></div></div><div class="ai-ops-toolbar"><div class="ai-ops-realtime ${realtimeLive ? 'is-live' : ''}" aria-label="AI 运营实时数据状态"><span class="provider-dot ${realtimeLive ? 'ok' : ''}"></span><div><strong id="aiOpsRealtimeState">${realtimeLive ? 'WSS 实时推送' : '实时通道重连中'}</strong><small><span data-terminal-platform-label>${terminalLabel}</span> 时间 <span id="aiOpsRealtimeLastAt">${terminalTime}</span></small></div></div><button class="secondary-button ai-ops-refresh" type="button" data-ai-refresh><span data-icon="refresh" aria-hidden="true"></span><span>刷新当前模块</span></button></div></header>${aiTabs()}<div id="aiOperationsContent" class="ai-ops-content" data-ai-panel="${state.aiTab}"></div>`
  renderIcons(main)
  bindAiTabs()
  main.querySelector('[data-ai-refresh]').addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    try {
      if (state.aiTab === 'governance') await loadAiGovernance()
      else if (state.aiTab === 'model-compare') await loadModelCompareWorkspace()
      else if (state.aiTab === 'memory') await loadPlatformMemory()
      else await loadAiOperations()
      toast('AI 运营数据已刷新', 'success')
    }
    catch (error) { button.disabled = false; handleError(error) }
    finally { button.disabled = false }
  })
  if (state.aiTab === 'model-compare') await loadModelCompareWorkspace()
  else if (state.aiTab === 'memory') await loadPlatformMemory()
  else await loadAiOperations()
}

function riskTabs() { return `<nav class="segment-tabs risk-audit-tabs" role="tablist" aria-label="风控管理分类"><button class="segment-tab ${state.riskTab === 'status' ? 'is-active' : ''}" role="tab" aria-selected="${state.riskTab === 'status'}" aria-controls="riskContent" data-risk-tab="status" type="button">风险状态</button><button class="segment-tab ${state.riskTab === 'rules' ? 'is-active' : ''}" role="tab" aria-selected="${state.riskTab === 'rules'}" aria-controls="riskContent" data-risk-tab="rules" type="button">平台规则</button></nav>` }
function accountRiskStatus(account) {
  const lifecycle = {
    transferred:{ label:'已转移', reason:'该 MT5 账户已归属其他平台账号' },
    switched:{ label:'已切换', reason:'该用户当前 Bridge 已切换到其他交易账户' },
    frozen:{ label:'已冻结', reason:'账户身份或交易权限尚未通过校验' },
    paused:{ label:'已暂停', reason:'该账户当前已暂停使用' },
  }[String(account.observe_status || '').toLowerCase()] || null
  const stopped = Boolean(lifecycle) || account.user_kill_switch || (account.halt_status && account.halt_status !== 'active') || !account.data_complete
  const reason = lifecycle?.reason || (account.user_kill_switch ? '账户紧急停止已开启' : !account.data_complete ? (account.data_incomplete_reason || '风控数据尚不完整') : account.halt_status && account.halt_status !== 'active' ? (account.halt_reason || '账户已暂停新开仓') : '当前允许交易')
  const statusLabel = lifecycle?.label || (account.user_kill_switch ? '紧急停止' : !account.data_complete ? '数据待补齐' : stopped ? '暂停交易' : '允许交易')
  const drawdown = account.drawdown_pct === null || account.drawdown_pct === undefined || account.drawdown_pct === '' ? null : Number(account.drawdown_pct)
  const losses = account.consecutive_losses === null || account.consecutive_losses === undefined || account.consecutive_losses === '' ? null : Number(account.consecutive_losses)
  const owner = account.user_nickname || account.user_email || `用户 #${account.user_id}`
  const login = account.login_account || `账户 #${account.id}`
  const server = account.broker_server || '未登记服务器'
  const snapshot = account.last_risk_snapshot_at ? formatDate(account.last_risk_snapshot_at, true) : '尚无快照'
  const cooldown = account.cooldown_until ? `冷却至 ${formatDate(account.cooldown_until, true)}` : ''
  return `<article class="risk-account-row ${stopped ? 'is-stopped' : 'is-ready'}" role="row">
    <div class="risk-account-identity" role="cell"><span class="health-mark ${stopped ? 'risk-stop' : ''}" aria-hidden="true">${stopped ? '!' : '✓'}</span><div><strong title="${escapeHtml(account.nickname || login)}">${escapeHtml(account.nickname || login)}</strong><small class="mono">登录 ${escapeHtml(login)} · ${escapeHtml(server)}</small><span class="risk-account-owner">${escapeHtml(owner)}</span></div></div>
    <div class="risk-account-cell risk-account-state" role="cell"><span class="risk-cell-label">交易状态</span><span class="badge ${stopped ? 'expired' : 'active'}">${statusLabel}</span><small title="${escapeHtml(reason)}">${escapeHtml(reason)}</small>${cooldown ? `<em>${escapeHtml(cooldown)}</em>` : ''}</div>
    <div class="risk-account-cell risk-account-drawdown" role="cell"><span class="risk-cell-label">当前回撤</span><strong>${Number.isFinite(drawdown) ? `${drawdown.toFixed(2)}%` : '--'}</strong><small>账户高点回撤</small></div>
    <div class="risk-account-cell risk-account-losses" role="cell"><span class="risk-cell-label">连续亏损</span><strong>${Number.isFinite(losses) ? Math.max(0, Math.trunc(losses)) : '--'}</strong><small>连续交易次数</small></div>
    <div class="risk-account-cell risk-account-snapshot" role="cell"><span class="risk-cell-label">风控快照</span><strong>${escapeHtml(snapshot)}</strong><small class="risk-account-data ${account.data_complete ? 'is-complete' : 'is-incomplete'}">${account.data_complete ? '数据完整' : '数据不完整'}</small></div>
  </article>`
}
function riskAccountPagination(pagination = {}) {
  const page = Math.max(1, Number(pagination.page) || 1)
  const pageSize = Math.max(1, Number(pagination.page_size) || state.riskAccountPageSize)
  const total = Math.max(0, Number(pagination.total) || 0)
  const totalPages = Math.max(1, Number(pagination.total_pages) || 1)
  const start = total ? (page - 1) * pageSize + 1 : 0
  const end = total ? Math.min(total, page * pageSize) : 0
  return `<footer class="pagination risk-account-pagination"><div class="risk-page-summary"><strong>${start}–${end}</strong><span>/ ${total} 个账户</span><small>每页 ${pageSize} 个，已切换账户最后</small></div><div class="risk-page-controls"><button class="secondary-button" id="accountRiskPrev" type="button" aria-label="查看上一页账户">上一页</button><span class="risk-page-number" aria-live="polite">第 <strong>${page}</strong> / ${totalPages} 页</span><button class="secondary-button" id="accountRiskNext" type="button" aria-label="查看下一页账户">下一页</button></div></footer>`
}
function riskStatusContent(data) {
  const s = data.summary, global = data.global_control
  const accountPagination = data.account_pagination || { page:1, page_size:state.riskAccountPageSize, total:data.accounts.length, total_pages:1 }
  return `<div class="risk-status-workspace"><section class="health-banner risk-global-banner ${global.global_kill_switch ? 'needs-attention' : 'is-healthy'}"><span class="health-mark ${global.global_kill_switch ? 'risk-stop' : ''}">${global.global_kill_switch ? '!' : '✓'}</span><div class="risk-global-copy"><span class="eyebrow">平台交易总闸门</span><h2>${global.global_kill_switch ? '平台已暂停所有新开仓' : '平台交易总闸门正常'}</h2><p>${global.global_kill_switch ? escapeHtml(global.reason || '管理员已开启紧急停止') : '平台闸门放行后，每个账户仍会继续接受独立风控检查。'}</p><small class="risk-global-updated">最后变更：${global.updated_at ? escapeHtml(formatDate(global.updated_at, true)) : '尚无变更记录'}</small></div><div class="stop-action risk-stop-action">${global.global_kill_switch ? '' : '<input class="input" id="globalStopReason" maxlength="120" aria-label="平台紧急停止原因" placeholder="填写停止原因（至少 4 个字）">'}<button class="${global.global_kill_switch ? 'secondary-button' : 'danger-button primary-button'}" data-global-stop type="button">${global.global_kill_switch ? '解除紧急停止' : '紧急停止新开仓'}</button></div></section><section class="metric-grid risk-metric-grid">${metric('今日风控检查',s.decisions_today,'全部交易请求',true)}${metric('调整后放行',s.adjusted_today,'已自动收紧参数')}${metric('今日拒绝',s.rejected_today,'正常规则命中')}${metric('暂停账户',s.paused_accounts,`共 ${s.trading_accounts} 个账户`)}</section><section class="panel risk-account-panel"><header class="section-head"><div><span class="eyebrow">账户级保护</span><h2>账户风险状态</h2><p>需处理账户优先排列，已切换账户统一排在最后。</p></div><div class="risk-account-panel-meta"><span>风险账户优先</span><strong>${Number(accountPagination.total || 0)}<small> 个账户</small></strong></div></header><div class="risk-account-table" role="table" aria-label="账户风险状态"><div class="risk-account-grid-head" role="row"><span role="columnheader">账户与归属</span><span role="columnheader">交易状态</span><span role="columnheader">当前回撤</span><span role="columnheader">连续亏损</span><span role="columnheader">风控快照</span></div><div class="risk-account-list" role="rowgroup">${data.accounts.map(accountRiskStatus).join('') || '<div class="empty-state">暂无交易账户</div>'}</div></div>${riskAccountPagination(accountPagination)}</section></div>`
}
function riskDecisionsContent(data) {
  return `<section class="panel"><form class="filter-bar compact-filter" id="riskDecisionFilter"><div class="field"><label for="riskDecision">决策结果</label><select class="select" id="riskDecision"><option value="all">全部结果</option><option value="pass">通过</option><option value="adjust">调整后通过</option><option value="reject">拒绝</option></select></div><button class="secondary-button" type="submit">筛选</button></form><div class="decision-list">${data.decisions.map(item => `<article class="decision-row"><div><strong>#${item.id} · ${escapeHtml(item.symbol || '--')}</strong><small>${escapeHtml(item.user_nickname || item.user_email || `用户 #${item.user_id}`)} · ${formatDate(item.created_at,true)}</small></div><div class="decision-reason"><span class="badge ${item.decision_status === 'reject' ? 'expired' : 'active'}">${item.decision_status === 'reject' ? '拒绝' : item.decision_status === 'adjust' ? '调整后通过' : '通过'}</span><p>${escapeHtml(item.reason || '风控检查已完成')}</p></div></article>`).join('') || '<div class="empty-state">没有符合条件的风控决策</div>'}</div><div class="pagination"><button class="secondary-button" id="riskPrev" type="button">上一页</button><span>第 ${data.pagination.page} / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><button class="secondary-button" id="riskNext" type="button">下一页</button></div></section>`
}
const auditTargetLabels={user:'用户',account:'交易账户',trading_account:'交易账户',strategy:'策略',model:'模型',order:'订单',system:'系统',system_config:'系统配置',referral_rules:'返佣规则',platform:'平台',risk_restore_request:'风险恢复'}
const auditTargetFilters=[['all','全部范围'],['user','用户'],['account','交易账户'],['strategy','策略'],['model','模型'],['order','订单'],['system','系统'],['system_config','系统配置'],['referral_rules','返佣规则'],['platform','平台']]
function auditEventIcon(targetType){return ({user:'users',account:'shield',trading_account:'shield',strategy:'activity',model:'settings',order:'commercial',system_config:'settings',referral_rules:'users',platform:'shield',system:'file'})[targetType]||'file'}
function auditEventCard(item){
  const details=Array.isArray(item.details||item.change_summary)?(item.details||item.change_summary).map(entry=>[entry.field_label||'未登记字段',entry.value||'未设置']):[['详情','服务端未返回可展示变更']]
  const actor=item.user_nickname||item.user_email||`管理员 #${item.user_id}`,target=item.target_label||item.target_type_label||auditTargetLabels[item.target_type]||'其他对象'
  const technical=item.action_label==='未登记的管理动作'||item.target_type_label==='未登记的管理对象'
  return `<article class="audit-event-card">
    <div class="audit-event-rail" aria-hidden="true"><span data-icon="${auditEventIcon(item.target_type)}"></span><i></i></div>
    <div class="audit-event-body"><header><div><span>事件 #${Number(item.id)||'--'}</span><h3>${escapeHtml(item.action_label||'管理操作')}</h3></div><time datetime="${escapeHtml(item.created_at||'')}">${escapeHtml(formatDate(item.created_at,true))}</time></header>
      <p class="audit-event-summary">${escapeHtml(item.summary||item.action_label||'已记录管理操作')}</p>
      <div class="audit-event-meta"><span data-icon="users" aria-hidden="true"></span><strong>${escapeHtml(actor)}</strong><span class="audit-target-badge">${escapeHtml(target)}</span><span class="audit-ip">IP ${escapeHtml(item.ip||'未记录')}</span></div>
      <dl class="audit-detail-grid">${details.map(([label,value])=>`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
      ${technical?`<details class="audit-technical-evidence"><summary>查看技术代码</summary><code>${escapeHtml(item.raw_action||item.action_code||'未记录')}</code></details>`:''}
    </div>
  </article>`
}
async function loadRiskAudit() {
  const params = new URLSearchParams({account_page:String(state.riskAccountPage),account_page_size:String(state.riskAccountPageSize)})
  const data = await api(`/api/admin/risk-audit/overview?${params}`)
  const accountPages = Math.max(1, Number(data.account_pagination?.total_pages || 1))
  if (state.riskAccountPage > accountPages) { state.riskAccountPage = accountPages; return loadRiskAudit() }
  state.riskData = data
  renderRiskContent()
}
async function renderAuditEvents(rootId='riskContent') {
  const params = new URLSearchParams({page:String(state.auditPage),page_size:'20'}); if(state.auditSearch) params.set('search',state.auditSearch);if(state.auditTarget&&state.auditTarget!=='all')params.set('target_type',state.auditTarget)
  const data = await api(`/api/admin/risk-audit/admin-events?${params}`)
  const root=document.querySelector(`#${rootId}`);if(!root)return
  const summary=data.summary||{},eventCount=Number(data.pagination.total||0),todayCount=Number(summary.today||0),actorCount=Number(summary.actors||new Set(data.events.map(item=>item.user_id)).size),targetCount=Number(summary.target_types||new Set(data.events.map(item=>item.target_type)).size)
  root.innerHTML = `<div class="audit-workspace"><section class="audit-summary-strip" aria-label="审计概览">
    <article><span class="audit-summary-icon" data-icon="file" aria-hidden="true"></span><div><span>匹配记录</span><strong>${eventCount.toLocaleString('zh-CN')}</strong><small>覆盖当前筛选范围</small></div></article>
    <article><span class="audit-summary-icon" data-icon="activity" aria-hidden="true"></span><div><span>今日变更</span><strong>${todayCount.toLocaleString('zh-CN')}</strong><small>按平台日期统计</small></div></article>
    <article><span class="audit-summary-icon" data-icon="users" aria-hidden="true"></span><div><span>涉及管理员</span><strong>${actorCount.toLocaleString('zh-CN')}</strong><small>当前结果中的操作者</small></div></article>
    <article><span class="audit-summary-icon" data-icon="shield" aria-hidden="true"></span><div><span>涉及范围</span><strong>${targetCount.toLocaleString('zh-CN')}</strong><small>用户、交易与系统配置</small></div></article>
  </section><section class="panel audit-filter-panel"><form id="auditSearchForm"><div class="audit-filter-intro"><span class="eyebrow">检索审计账本</span><strong>定位平台变更</strong><small>支持按管理员、动作、详情和对象范围查询。</small></div><label class="field audit-search-field" for="auditSearch"><span>关键词</span><div><span data-icon="search" aria-hidden="true"></span><input class="input" id="auditSearch" value="${escapeHtml(state.auditSearch)}" placeholder="管理员、动作或详情"></div></label><label class="field audit-target-field" for="auditTarget"><span>对象范围</span><select class="select" id="auditTarget">${auditTargetFilters.map(([value,label])=>`<option value="${value}" ${state.auditTarget===value?'selected':''}>${label}</option>`).join('')}</select></label><div class="audit-filter-actions"><button class="secondary-button" id="auditClearFilters" type="button" ${!state.auditSearch&&state.auditTarget==='all'?'disabled':''}>清除</button><button class="primary-button" type="submit"><span data-icon="search" aria-hidden="true"></span>查询记录</button></div></form></section>
  <section class="panel audit-ledger-panel"><header class="audit-ledger-head"><div><span class="eyebrow">不可变更记录</span><h2>操作事件账本</h2><p>按时间倒序展示，敏感凭证仅显示为已隐藏。</p></div><div><strong>${eventCount.toLocaleString('zh-CN')}</strong><span>条记录</span></div></header><div class="audit-event-list">${data.events.map(auditEventCard).join('')||'<div class="empty-state audit-empty-state"><strong>没有符合条件的审计记录</strong><p>调整关键词或对象范围后重新查询。</p></div>'}</div><footer class="pagination audit-pagination"><button class="secondary-button" id="auditPrev" type="button">上一页</button><span>第 <strong>${data.pagination.page}</strong> / ${data.pagination.total_pages} 页 · 共 ${eventCount.toLocaleString('zh-CN')} 条</span><button class="secondary-button" id="auditNext" type="button">下一页</button></footer></section></div>`
  renderIcons(root)
  root.querySelector('#auditSearchForm').onsubmit=e=>{e.preventDefault();state.auditSearch=root.querySelector('#auditSearch').value.trim();state.auditTarget=root.querySelector('#auditTarget').value;state.auditPage=1;renderAuditEvents(rootId).catch(handleError)}
  root.querySelector('#auditTarget').onchange=e=>{state.auditTarget=e.target.value;state.auditPage=1;renderAuditEvents(rootId).catch(handleError)}
  root.querySelector('#auditClearFilters').onclick=()=>{state.auditSearch='';state.auditTarget='all';state.auditPage=1;renderAuditEvents(rootId).catch(handleError)}
  root.querySelector('#auditPrev').disabled=data.pagination.page<=1; root.querySelector('#auditNext').disabled=data.pagination.page>=data.pagination.total_pages
  root.querySelector('#auditPrev').onclick=()=>{state.auditPage--;renderAuditEvents(rootId).catch(handleError)};root.querySelector('#auditNext').onclick=()=>{state.auditPage++;renderAuditEvents(rootId).catch(handleError)}
}
async function renderManagementAudit(){
  const main=document.querySelector('#adminMain')
  main.innerHTML=`<header class="page-head management-audit-head"><div class="audit-title-lockup"><span class="audit-title-icon" data-icon="file" aria-hidden="true"></span><div><span class="eyebrow">平台变更追踪</span><h1>管理审计</h1><p>完整追踪管理员对用户、交易、风控、商业规则和系统配置的操作记录。</p></div></div><aside class="audit-integrity-card"><span data-icon="shield" aria-hidden="true"></span><div><strong>只读审计账本</strong><small>记录不可在管理台修改或删除</small></div><em><i></i>完整性保护</em></aside></header><div id="managementAuditContent"><div class="panel"><div class="empty-state">正在读取管理操作记录…</div></div></div>`
  renderIcons(main);await renderAuditEvents('managementAuditContent')
}
function bindRiskStatus() {
  const stop=document.querySelector('[data-global-stop]')
  if(stop)stop.onclick=async()=>{const enabled=!state.riskData.global_control.global_kill_switch;const reason=enabled?(document.querySelector('#globalStopReason')?.value.trim()||''):'';if(enabled&&reason.length<4){toast('请先填写至少 4 个字的停止原因','error');document.querySelector('#globalStopReason')?.focus();return} if(!await confirmAction(enabled?'开启平台紧急停止':'解除平台紧急停止',enabled?'开启后所有账户都不能新增仓位。':'解除后各账户仍会继续接受自身风控检查。',enabled?'确认停止':'确认解除',enabled))return;try{await api('/api/admin/risk-audit/global-stop',{method:'POST',body:JSON.stringify({enabled,reason})});toast('平台紧急停止状态已更新','success');await loadRiskAudit()}catch(error){handleError(error)}}
  const pagination=state.riskData.account_pagination||{page:1,total_pages:1}
  const previous=document.querySelector('#accountRiskPrev'),next=document.querySelector('#accountRiskNext')
  if(previous){previous.disabled=Number(pagination.page)<=1;previous.onclick=()=>{state.riskAccountPage=Math.max(1,Number(pagination.page)-1);loadRiskAudit().catch(handleError)}}
  if(next){next.disabled=Number(pagination.page)>=Number(pagination.total_pages);next.onclick=()=>{state.riskAccountPage=Number(pagination.page)+1;loadRiskAudit().catch(handleError)}}
}
const riskSafetyLabels={lower:'数值越低，保护越严格',higher:'数值越高，保护越严格',subset:'仅允许平台范围内的子集',locked_true:'系统固定开启'}
function riskValueControl(key,meta,value,disabled=false,label='平台值'){
  const ariaLabel=escapeHtml(`${meta.label} ${label}`)
  if(meta.type==='boolean')return `<select class="select" aria-label="${ariaLabel}" data-risk-value="${key}" ${disabled?'disabled':''}><option value="true" ${value?'selected':''}>开启</option><option value="false" ${!value?'selected':''}>关闭</option></select>`
  if(meta.type==='set')return `<input class="input" type="text" aria-label="${ariaLabel}" data-risk-value="${key}" value="${escapeHtml((value||[]).join(', '))}" ${disabled?'disabled':''}>`
  return `<div class="unit-input"><input class="input" type="number" step="any" min="${meta.allowed_min}" max="${meta.allowed_max}" aria-label="${ariaLabel}" data-risk-value="${key}" value="${escapeHtml(value)}" ${disabled?'disabled':''}><span>${escapeHtml(meta.unit_label||meta.unit||'')}</span></div>`
}
function renderRiskRuleRow(key,meta,policy){
  const control=policy.controls[key]||{}
  const managed=meta.user_editable&&!meta.locked&&meta.type==='number'
  const unit=escapeHtml(meta.unit_label||meta.unit||'规则')
  const searchText=`${key} ${meta.code||''} ${meta.label||''} ${meta.description||''} ${meta.unit_label||''}`.toLowerCase()
  const fixedTitle=meta.locked?'系统强制执行':'仅平台可配置'
  const fixedDescription=meta.locked?'该规则不能被用户、策略或模型关闭。':'普通用户不可修改此规则，只使用平台当前值。'
  return `<article class="risk-policy-row" data-risk-rule-row="${key}" data-risk-search="${escapeHtml(searchText)}">
    <div class="risk-rule-identity"><div><strong>${escapeHtml(meta.label)}</strong><code>${escapeHtml(meta.code||key)}</code></div><p>${escapeHtml(meta.description||'平台交易安全规则')}</p><small>${escapeHtml(riskSafetyLabels[meta.safety_direction]||'按平台边界强制执行')}</small></div>
    <label class="risk-policy-cell risk-policy-default"><span class="risk-mobile-field">平台值</span>${riskValueControl(key,meta,policy.values[key],meta.locked,'平台值')}</label>
    ${managed?`<label class="risk-policy-cell risk-policy-min"><span class="risk-mobile-field">用户最小值</span><div class="unit-input"><input class="input" type="number" step="any" min="${meta.allowed_min}" max="${meta.allowed_max}" aria-label="${escapeHtml(`${meta.label} 用户最小值`)}" data-risk-min="${key}" value="${escapeHtml(control.allowed_min)}"><span>${unit}</span></div></label><label class="risk-policy-cell risk-policy-max"><span class="risk-mobile-field">用户最大值</span><div class="unit-input"><input class="input" type="number" step="any" min="${meta.allowed_min}" max="${meta.allowed_max}" aria-label="${escapeHtml(`${meta.label} 用户最大值`)}" data-risk-max="${key}" value="${escapeHtml(control.allowed_max)}"><span>${unit}</span></div></label><label class="risk-policy-cell risk-policy-lock"><span class="risk-mobile-field">平台锁定值</span><div class="unit-input"><input class="input" type="number" step="any" min="${control.allowed_min}" max="${control.allowed_max}" aria-label="${escapeHtml(`${meta.label} 平台锁定值`)}" data-risk-lock="${key}" value="${control.locked_value??''}" placeholder="不锁定"><span>${unit}</span></div></label>`:`<div class="risk-rule-scope-cell"><span class="risk-rule-scope-mark ${meta.locked?'is-locked':''}" aria-hidden="true"></span><div><strong>${fixedTitle}</strong><small>${fixedDescription}</small></div></div>`}
  </article>`
}
function renderPlatformRiskPolicy(){
  const root=document.querySelector('#riskContent'),policy=state.riskPolicy
  if(!root||!policy)return
  const entries=Object.entries(policy.rule_metadata||{})
  const userManaged=entries.filter(([,meta])=>meta.user_editable&&!meta.locked&&meta.type==='number').length
  const systemLocked=entries.filter(([,meta])=>meta.locked).length
  const effectiveAt=policy.version?.effective_at||policy.version?.created_at
  state.riskPolicyHasChanges=false
  root.innerHTML=`<form id="platformRiskForm" class="risk-policy-workbench"><section class="risk-policy-console"><div class="risk-policy-version"><span>当前生效版本</span><strong>V${policy.version?.version_no||'默认'}</strong><small>${effectiveAt?escapeHtml(formatDate(effectiveAt,true)):'使用系统默认规则'}</small></div><label class="risk-policy-console-field"><span>搜索规则</span><div class="risk-policy-search-control"><i data-icon="search" aria-hidden="true"></i><input class="input" id="riskPolicySearch" value="${escapeHtml(state.riskPolicySearch)}" autocomplete="off" placeholder="名称、编号或说明"><small id="riskPolicySearchCount">${entries.length} / ${entries.length}</small></div></label><label class="risk-policy-console-field"><span>本次调整说明</span><input class="input" id="riskChangeReason" minlength="4" maxlength="120" required placeholder="请说明调整原因（至少 4 个字）"></label><div class="risk-policy-save-action"><span id="riskPolicyDirtyStatus">暂无未保存修改</span><button class="primary-button" data-risk-save type="submit" disabled>保存并立即生效</button></div></section><section class="panel risk-policy-matrix"><header class="section-head"><div><span class="eyebrow">统一规则矩阵</span><h2>平台交易规则</h2><p>一行一条规则；平台值决定默认行为，用户范围决定账户可调整边界。</p></div><div class="risk-policy-summary"><span>全部 <b>${entries.length}</b></span><span>用户可调 <b>${userManaged}</b></span><span>系统强制 <b>${systemLocked}</b></span></div></header><div class="risk-policy-matrix-head" aria-hidden="true"><span>规则与执行方向</span><span>平台值</span><span>用户最小值</span><span>用户最大值</span><span>平台锁定值</span></div><div class="risk-policy-matrix-list">${entries.map(([key,meta])=>renderRiskRuleRow(key,meta,policy)).join('')}<div class="empty-state" id="riskPolicyEmpty" hidden>没有符合搜索条件的规则</div></div></section></form>`
  renderIcons(root)
  const search=root.querySelector('#riskPolicySearch'),searchCount=root.querySelector('#riskPolicySearchCount'),empty=root.querySelector('#riskPolicyEmpty')
  const applySearch=()=>{const query=search.value.trim().toLowerCase();state.riskPolicySearch=search.value;let visible=0;root.querySelectorAll('[data-risk-rule-row]').forEach(row=>{const matched=!query||row.dataset.riskSearch.includes(query);row.hidden=!matched;if(matched)visible++});searchCount.textContent=`${visible} / ${entries.length}`;empty.hidden=visible!==0}
  search.addEventListener('input',applySearch);search.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault()});applySearch()
  const controls=[...root.querySelectorAll('[data-risk-value],[data-risk-min],[data-risk-max],[data-risk-lock]')]
  const initialValues=new Map(controls.map(control=>[control,control.value]))
  const controlKey=control=>control.dataset.riskValue||control.dataset.riskMin||control.dataset.riskMax||control.dataset.riskLock
  const dirtyStatus=root.querySelector('#riskPolicyDirtyStatus'),saveButton=root.querySelector('[data-risk-save]')
  const refreshDirtyState=()=>{const dirtyKeys=new Set();controls.forEach(control=>{if(control.value!==initialValues.get(control))dirtyKeys.add(controlKey(control))});root.querySelectorAll('[data-risk-rule-row]').forEach(row=>row.classList.toggle('is-dirty',dirtyKeys.has(row.dataset.riskRuleRow)));state.riskPolicyHasChanges=dirtyKeys.size>0;dirtyStatus.textContent=dirtyKeys.size?`已修改 ${dirtyKeys.size} 项规则`:'暂无未保存修改';dirtyStatus.classList.toggle('is-dirty',dirtyKeys.size>0);saveButton.disabled=!dirtyKeys.size}
  controls.forEach(control=>control.addEventListener(control.tagName==='SELECT'?'change':'input',refreshDirtyState))
  root.querySelector('#platformRiskForm').onsubmit=async event=>{
    event.preventDefault();if(!state.riskPolicyHasChanges)return
    const reason=root.querySelector('#riskChangeReason').value.trim(),button=event.submitter||saveButton
    if(reason.length<4){toast('请填写至少 4 个字的调整说明','error');root.querySelector('#riskChangeReason').focus();return}
    button.disabled=true
    try{const values={},controlsPayload={};root.querySelectorAll('[data-risk-value]').forEach(input=>{const meta=policy.rule_metadata[input.dataset.riskValue];values[input.dataset.riskValue]=meta.type==='boolean'?input.value==='true':meta.type==='set'?input.value.split(',').map(v=>v.trim()).filter(Boolean):Number(input.value)});root.querySelectorAll('[data-risk-min]').forEach(input=>{controlsPayload[input.dataset.riskMin]||={};controlsPayload[input.dataset.riskMin].allowed_min=Number(input.value)});root.querySelectorAll('[data-risk-max]').forEach(input=>{controlsPayload[input.dataset.riskMax]||={};controlsPayload[input.dataset.riskMax].allowed_max=Number(input.value)});root.querySelectorAll('[data-risk-lock]').forEach(input=>{controlsPayload[input.dataset.riskLock]||={};controlsPayload[input.dataset.riskLock].locked_value=input.value===''?null:Number(input.value)});await api('/api/admin/risk-audit/platform-policy',{method:'PUT',body:JSON.stringify({values,controls:controlsPayload,reason})});state.riskPolicyHasChanges=false;toast('平台风控规则已立即生效','success');await loadPlatformRiskPolicy()}catch(error){handleError(error)}finally{if(root.contains(button))button.disabled=!state.riskPolicyHasChanges}}
}
async function loadPlatformRiskPolicy(){const data=await api('/api/admin/risk-audit/platform-policy');state.riskPolicy=data.policy;renderPlatformRiskPolicy()}
function renderRiskContent(){const root=document.querySelector('#riskContent');if(!root||!state.riskData)return;root.innerHTML=riskStatusContent(state.riskData);bindRiskStatus()}
async function renderRiskAudit(){
  if(!['status','rules'].includes(state.riskTab))state.riskTab='status'
  const main=document.querySelector('#adminMain')
  main.innerHTML=`<header class="page-head risk-audit-head"><div class="risk-audit-title-lockup"><span class="risk-audit-title-icon" data-icon="shield" aria-hidden="true"></span><div><span class="eyebrow">交易安全与平台边界</span><h1>风控管理</h1><p>先确认平台和账户能否交易，再维护统一规则与账户可调边界。</p></div></div><div class="risk-audit-assurance" aria-label="风控工作台能力"><span>账户与平台双层检查</span><span>规则版本完整留存</span></div></header>${riskTabs()}<div id="riskContent" role="tabpanel"><div class="panel"><div class="empty-state">正在读取风控状态…</div></div></div>`
  renderIcons(main)
  document.querySelectorAll('[data-risk-tab]').forEach(button=>button.onclick=async()=>{
    const nextTab=button.dataset.riskTab
    if(state.riskTab==='rules'&&state.riskPolicyHasChanges&&nextTab!=='rules'&&!await confirmAction('放弃未保存的规则修改？','切换页面后，本次尚未保存的规则调整会丢失。','确认放弃',true))return
    state.riskPolicyHasChanges=false;state.riskTab=nextTab
    document.querySelectorAll('[data-risk-tab]').forEach(item=>{const selected=item===button;item.classList.toggle('is-active',selected);item.setAttribute('aria-selected',String(selected))})
    if(state.riskTab==='rules')await loadPlatformRiskPolicy();else if(!state.riskData)await loadRiskAudit();else renderRiskContent()
  })
  if(state.riskTab==='rules')await loadPlatformRiskPolicy();else await loadRiskAudit()
}

const contentTabItems=[
  {id:'courses',label:'课程库',hint:'发布与编排',icon:'book'},
  {id:'assets',label:'课件与测验',hint:'附件、题库与导图',icon:'paperclip'},
  {id:'video',label:'视频管理',hint:'上传与播放源',icon:'video'},
  {id:'engagement',label:'学习数据',hint:'完成与活跃',icon:'analytics'},
  {id:'feedback',label:'用户反馈',hint:'建议与问题',icon:'message'},
]
function contentTabs(){return `<nav class="content-workspace-tabs" role="tablist" aria-label="内容运营工作区">${contentTabItems.map(item=>`<button class="content-workspace-tab ${state.contentTab===item.id?'is-active':''}" id="contentTab_${item.id}" data-content-tab="${item.id}" type="button" role="tab" aria-controls="contentSystemBody" aria-selected="${state.contentTab===item.id}"><span class="content-tab-icon" data-icon="${item.icon}" aria-hidden="true"></span><span class="content-tab-copy"><strong>${item.label}</strong><small>${item.hint}</small></span><i aria-hidden="true"></i></button>`).join('')}</nav>`}
const courseStatusLabels={published:'已发布',draft:'草稿',archived:'已归档'}
const accessLabels={free:'公开免费',logged_in:'登录可看',plus_pro:'Plus / Pro',pro_only:'仅 Pro'}
const courseCategoryLabels={morning:'早盘解读',indicator:'技术指标',pattern:'形态分析',strategy:'交易策略',advanced:'经济指标'}
function formatContentFileSize(bytes){const size=Math.max(0,Number(bytes||0));if(!size)return '大小未知';if(size<1024)return `${size} B`;if(size<1024*1024)return `${(size/1024).toFixed(size<10240?1:0)} KB`;return `${(size/1024/1024).toFixed(1)} MB`}
function courseUpdatedLabel(course){return course.updated_at||course.created_at?formatDate(course.updated_at||course.created_at,true):'时间未记录'}
function courseCoverDisplayUrl(course){const url=String(course?.cover||'').trim();return url.includes('.hdslb.com/')?`/api/bilibili-proxy?url=${encodeURIComponent(url)}`:url.replace(/^http:\/\//,'https://')}
let courseModalReturnFocus=null
function closeCourseEditor(){
  document.querySelector('#contentModal').hidden=true
  courseModalReturnFocus?.focus?.()
  courseModalReturnFocus=null
}
function courseEditorMarkup(course={}) {
  const selected=(value,current)=>value===current?'selected':''
  const status=course.status||'draft',access=course.access_level||'free'
  return `<form id="courseEditorForm" class="editor-form course-editor-form">
    <input type="hidden" id="courseId" value="${escapeHtml(course.id||'')}">
    <div class="course-editor-layout">
      <div class="course-editor-main">
        <section class="editor-section course-editor-identity"><header class="editor-section-head"><span class="editor-section-icon" data-icon="book" aria-hidden="true"></span><div><h3>课程基本信息</h3><p>用于主站课程列表、详情页和搜索结果。</p></div><span class="editor-section-tag">主站展示</span></header><div class="form-grid">
          <div class="field span-2"><label for="courseTitle">课程标题 <em class="required-mark">必填</em></label><input class="input" id="courseTitle" required maxlength="200" value="${escapeHtml(course.title||'')}" placeholder="输入面向用户的课程标题"><small class="helper">清晰说明主题和价值，建议不超过 30 个字。</small></div>
          <div class="field span-2"><label for="courseDescription">课程说明</label><textarea class="input editor-textarea course-description-input" id="courseDescription" maxlength="2000" placeholder="概括学习目标、内容边界与适合人群">${escapeHtml(course.description||'')}</textarea><small class="helper">建议控制在 80–160 字，方便用户快速判断课程价值。</small></div>
          <div class="field"><label for="courseCategory">发布栏目</label><select class="select" id="courseCategory" required>${Object.entries(courseCategoryLabels).map(([value,label])=>`<option value="${value}" ${selected(value,course.category||'morning')}>${label}</option>`).join('')}</select></div>
          <div class="field"><label for="courseContentType">内容类型</label><select class="select" id="courseContentType"><option value="video" ${selected('video',course.content_type||'video')}>视频课程</option><option value="article" ${selected('article',course.content_type)}>文章课程</option></select></div>
        </div></section>
        <section class="editor-section course-editor-source"><header class="editor-section-head"><span class="editor-section-icon" data-icon="video" aria-hidden="true"></span><div><h3>课程内容来源</h3><p>配置视频、封面或文章地址，未填写的来源不会展示。</p></div><span class="editor-section-tag">内容交付</span></header><div class="form-grid">
          <div class="field"><label for="courseBilibili">哔哩哔哩视频编号</label><input class="input" id="courseBilibili" value="${escapeHtml(course.bilibili_id||'')}" placeholder="例如 BV1xx411c7mD"><small class="helper">填写 BV 编号，系统会自动补充可用的封面和时长。</small></div>
          <div class="field"><label for="courseDuration">课程时长</label><input class="input mono" id="courseDuration" value="${escapeHtml(course.duration||'')}" placeholder="例如 18:30"><small class="helper">可手动修正自动识别的时长。</small></div>
          <div class="field span-2"><label for="courseCover">封面地址</label><input class="input" id="courseCover" type="url" value="${escapeHtml(course.cover||'')}" placeholder="https://..."><small class="helper">建议使用清晰的横版封面；留空时优先读取视频封面。</small></div>
          <div class="field span-2"><label for="courseArticleUrl">文章地址</label><input class="input" id="courseArticleUrl" type="url" value="${escapeHtml(course.article_url||'')}" placeholder="文章课程使用，可填写站内或外部地址"><small class="helper">仅文章课程需要填写，支持站内路径或完整链接。</small></div>
        </div></section>
      </div>
      <aside class="course-editor-side">
        <section class="editor-section course-publish-card"><header class="editor-section-head"><span class="editor-section-icon" data-icon="shield" aria-hidden="true"></span><div><h3>发布与权限</h3><p>保存后立即同步到主站。</p></div></header><div class="course-publish-preview" data-course-publish-preview><span class="course-publish-preview-dot" aria-hidden="true"></span><div><strong>${courseStatusLabels[status]||'草稿'}</strong><small>${accessLabels[access]||'公开免费'}</small></div></div><div class="course-publish-fields">
          <div class="field"><label for="courseStatus">发布状态</label><select class="select" id="courseStatus"><option value="draft" ${selected('draft',status)}>草稿</option><option value="published" ${selected('published',status)}>已发布</option><option value="archived" ${selected('archived',status)}>已归档</option></select></div>
          <div class="field"><label for="courseAccess">访问权限</label><select class="select" id="courseAccess">${Object.entries(accessLabels).map(([value,label])=>`<option value="${value}" ${selected(value,access)}>${label}</option>`).join('')}</select></div>
          <div class="course-number-grid"><div class="field"><label for="courseNumber">展示编号</label><input class="input mono" id="courseNumber" type="number" min="0" value="${escapeHtml(course.number||'')}"></div><div class="field"><label for="courseSortOrder">排序值</label><input class="input mono" id="courseSortOrder" type="number" min="0" value="${escapeHtml(course.sort_order||0)}"></div></div>
        </div></section>
        <section class="editor-section course-resource-brief"><header class="editor-section-head"><span class="editor-section-icon" data-icon="paperclip" aria-hidden="true"></span><div><h3>配套资源</h3><p>附件权限自动跟随课程。</p></div></header><div class="course-resource-brief-grid"><span><strong>${Number(course.attachment_count||0)}</strong>下载附件</span><span><strong>${Number(course.quiz_count||0)}</strong>测验题目</span><span><strong>${Number(course.mindmap_count||0)+Number(course.knowledge_count||0)}</strong>可视资料</span></div>${course.id?'<button class="secondary-button course-resource-manage" data-open-course-assets type="button"><span data-icon="paperclip"></span>管理课件与附件</button>':'<div class="course-resource-create-hint"><span data-icon="info" aria-hidden="true"></span><p>先创建课程，随后即可上传附件、题库和可视资料。</p></div>'}</section>
      </aside>
    </div>
    <footer class="form-actions editor-actions">${course.id?'<button class="text-button danger-text course-delete-action" data-delete-course type="button"><span data-icon="trash" aria-hidden="true"></span>删除课程</button>':'<span></span>'}<div class="course-editor-action-note"><span data-icon="check" aria-hidden="true"></span><div><strong>${course.id?'修改将在保存后生效':'创建后可继续补充课件与测验'}</strong><small>课程状态和访问权限会同步到主站。</small></div></div><div class="course-editor-action-buttons"><button class="secondary-button" data-close-content-modal type="button">取消</button><button class="primary-button" type="submit"><span data-icon="save" aria-hidden="true"></span>${course.id?'保存修改':'创建课程'}</button></div></footer>
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
    document.querySelector('#contentModalSubtitle').textContent=course.id?'修改课程内容、发布权限和配套资源。':'先创建课程主体，随后可以继续添加课件与测验。'
    const modalState=document.querySelector('#contentModalState')
    const updateModalState=()=>{const statusValue=body.querySelector('#courseStatus')?.value||course.status||'draft',accessValue=body.querySelector('#courseAccess')?.value||course.access_level||'free';modalState.dataset.status=statusValue;modalState.querySelector('span').textContent=`${courseStatusLabels[statusValue]||'草稿'} · ${accessLabels[accessValue]||'公开免费'}`;const preview=body.querySelector('[data-course-publish-preview]');if(preview){preview.dataset.status=statusValue;preview.querySelector('strong').textContent=courseStatusLabels[statusValue]||'草稿';preview.querySelector('small').textContent=accessLabels[accessValue]||'公开免费'}}
    body.innerHTML=courseEditorMarkup(course)
    renderIcons(body)
    updateModalState()
    body.querySelector('#courseStatus').onchange=updateModalState
    body.querySelector('#courseAccess').onchange=updateModalState
    body.querySelectorAll('[data-close-content-modal]').forEach(button=>button.onclick=closeCourseEditor)
    body.querySelector('[data-open-course-assets]')?.addEventListener('click',async()=>{
      state.contentTab='assets';state.courseAssets.episodeId=Number(course.id);state.courseAssets.editingQuestion=null;closeCourseEditor();await renderContentOperationsPage()
    })
    body.querySelector('[data-delete-course]')?.addEventListener('click',async()=>{
      if(!await confirmAction('删除这门课程？','课程、测试、资源、学习进度和评论都会被永久删除，无法恢复。','确认永久删除',true))return
      await api(`/api/admin/content-system/courses/${course.id}`,{method:'DELETE'})
      toast('课程已删除','success');closeCourseEditor();await renderContentCourses()
    })
    body.querySelector('#courseEditorForm').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true
      const payload={id:course.id||undefined,title:body.querySelector('#courseTitle').value.trim(),description:body.querySelector('#courseDescription').value.trim(),category:body.querySelector('#courseCategory').value,content_type:body.querySelector('#courseContentType').value,status:body.querySelector('#courseStatus').value,access_level:body.querySelector('#courseAccess').value,number:Number(body.querySelector('#courseNumber').value||0),sort_order:Number(body.querySelector('#courseSortOrder').value||0),bilibili_id:body.querySelector('#courseBilibili').value.trim(),youtube_id:String(course.youtube_id||''),duration:body.querySelector('#courseDuration').value.trim(),cover:body.querySelector('#courseCover').value.trim(),article_url:body.querySelector('#courseArticleUrl').value.trim()}
      try{await api('/api/admin/content-system/courses',{method:'POST',body:JSON.stringify(payload)});toast(course.id?'课程已保存':'课程已创建','success');closeCourseEditor();await renderContentCourses()}catch(error){handleError(error)}finally{button.disabled=false}
    }
    body.querySelector('#courseTitle').focus()
  } catch(error){body.innerHTML=`<div class="empty-state">${escapeHtml(error.message)}</div>`}
}
async function renderContentCourses() {
  const params=new URLSearchParams({page:String(state.contentPage),page_size:'20',status:state.contentStatus})
  if(state.contentSearch)params.set('search',state.contentSearch)
  const data=await api(`/api/admin/content-system/courses?${params}`)
  const root=document.querySelector('#contentSystemBody')
  root.innerHTML=`<section class="panel content-course-library">
    <header class="content-library-toolbar">
      <div class="content-library-heading"><span class="eyebrow">课程目录</span><strong>课程编排与发布</strong><small>点击任意课程进入编辑；状态与权限保存后立即生效。</small></div>
      <form id="courseFilters" class="content-course-filters">
        <label class="content-search-field" for="contentSearch"><span data-icon="search" aria-hidden="true"></span><input class="input" id="contentSearch" value="${escapeHtml(state.contentSearch)}" placeholder="搜索标题、说明或栏目"><small>Enter</small></label>
        <label class="field content-status-filter"><span>发布状态</span><select class="select" id="contentStatus"><option value="all">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option><option value="archived">已归档</option></select></label>
        <button class="secondary-button" type="submit"><span data-icon="search" aria-hidden="true"></span>查询</button>
      </form>
      <div class="content-library-count"><span>匹配课程</span><strong>${Number(data.pagination.total||0).toLocaleString('zh-CN')}</strong><small>门</small></div>
    </header>
    <div class="course-library-columns" aria-hidden="true"><span>课程内容</span><span>发布状态</span><span>资源完整度</span><span>最近更新</span><span>操作</span></div>
    <div class="course-operations-list">${data.courses.map(course=>{
      const assetTotal=Number(course.attachment_count||0)+Number(course.quiz_count||0)+Number(course.mindmap_count||0)+Number(course.knowledge_count||0)
      return `<button class="course-operations-row" data-edit-course="${course.id}" type="button" aria-label="编辑课程：${escapeHtml(course.title)}">
        <span class="course-cover-cell"><span class="course-cover-frame">${courseCoverDisplayUrl(course)?`<img src="${escapeHtml(courseCoverDisplayUrl(course))}" alt="" loading="lazy">`:''}<b>${String(course.number||course.id).padStart(2,'0')}</b></span><span class="course-title-cell"><strong>${escapeHtml(course.title)}</strong><small>${escapeHtml(courseCategoryLabels[course.category]||'未分类')} · ${course.content_type==='article'?'文章课程':'视频课程'} · 编号 ${String(course.number||course.id).padStart(2,'0')}</small><p>${escapeHtml(course.description||'尚未填写课程说明')}</p></span></span>
        <span class="course-publish-cell"><span class="badge course-state-${escapeHtml(course.status)} ${course.status==='published'?'active':''}">${courseStatusLabels[course.status]||'未知状态'}</span><small>${accessLabels[course.access_level]||'未设置权限'}</small></span>
        <span class="course-resource-cell"><span><b>${Number(course.attachment_count||0)}</b>附件</span><span><b>${Number(course.quiz_count||0)}</b>测验</span><span><b>${Number(course.mindmap_count||0)+Number(course.knowledge_count||0)}</b>图解</span><small class="${assetTotal?'has-assets':'needs-assets'}">${assetTotal?'已配置配套资源':'尚无配套资源'}</small></span>
        <time class="course-updated-cell">${escapeHtml(courseUpdatedLabel(course))}</time>
        <span class="course-row-action"><span data-icon="chevron" aria-hidden="true"></span><small>编辑</small></span>
      </button>`
    }).join('')||'<div class="empty-state content-empty-state"><span class="content-empty-icon" data-icon="search" aria-hidden="true"></span><div><strong>没有符合条件的课程</strong><p>调整搜索词或发布状态后重试。</p></div></div>'}</div>
    <footer class="pagination content-pagination"><span>第 <strong>${data.pagination.page}</strong> / ${data.pagination.total_pages} 页 · 共 ${data.pagination.total} 条</span><div><button class="secondary-button" id="contentPrev" type="button">上一页</button><button class="secondary-button" id="contentNext" type="button">下一页</button></div></footer>
  </section>`
  renderIcons(root)
  const status=document.querySelector('#contentStatus');status.value=state.contentStatus
  document.querySelector('#courseFilters').onsubmit=e=>{e.preventDefault();state.contentSearch=document.querySelector('#contentSearch').value.trim();state.contentPage=1;renderContentCourses().catch(handleError)}
  status.onchange=()=>{state.contentStatus=status.value;state.contentPage=1;renderContentCourses().catch(handleError)}
  document.querySelectorAll('[data-edit-course]').forEach(button=>button.onclick=()=>openCourseEditor(button.dataset.editCourse))
  document.querySelector('#contentPrev').disabled=data.pagination.page<=1
  document.querySelector('#contentNext').disabled=data.pagination.page>=data.pagination.total_pages
  document.querySelector('#contentPrev').onclick=()=>{state.contentPage--;renderContentCourses().catch(handleError)}
  document.querySelector('#contentNext').onclick=()=>{state.contentPage++;renderContentCourses().catch(handleError)}
}
function courseResourceTypeLabel(resource){if(resource.type==='mindmap')return resource.structure?'结构导图':'导图图片';if(resource.type==='knowledge')return '信息图';return resource.type||'课程资料'}
function legacyCourseAssetWorkspace() {
  const asset=state.courseAssets,course=asset.courses.find(item=>Number(item.id)===Number(asset.episodeId)),resources=asset.resources?.resources||[],questions=asset.questions||[],editing=asset.editingQuestion||{}
  return `<section class="course-asset-workspace"><article class="panel asset-course-picker"><header class="section-head"><div><span class="eyebrow">课程选择</span><h2>测验与配套资料</h2><p>选择课程后，统一管理题目、导图和信息图。</p></div></header><div class="panel-body"><label class="field"><span>当前课程</span><select class="select" id="assetCourseSelect">${asset.courses.map(item=>`<option value="${item.id}" ${Number(item.id)===Number(asset.episodeId)?'selected':''}>${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="asset-summary"><span>题目<strong>${Number(asset.resources?.quizCount||0)}</strong></span><span>课程资料<strong>${resources.length}</strong></span><span>课程编号<strong>${course?.number||course?.id||'--'}</strong></span></div></div></article><section class="course-asset-grid"><article class="panel"><header class="section-head"><div><h2>批量导入资料</h2><p>支持 NotebookLM 导出的题目 JSON、导图 JSON 与图片。</p></div></header><form class="asset-upload-form" id="courseAssetUpload"><label class="file-drop"><input id="courseAssetFiles" type="file" multiple accept=".json,application/json,image/png,image/jpeg,image/webp"><span><strong>选择 JSON 或图片文件</strong><small id="courseAssetFileLabel">最多 50 个文件；服务端按文件名与内容自动识别</small></span></label><div class="asset-type-checks"><label><input type="checkbox" id="assetIncludeQuiz" checked> 导入测验题目</label><label><input type="checkbox" id="assetIncludeMindmap" checked> 导入思维导图</label><label><input type="checkbox" id="assetIncludeInfographic" checked> 导入信息图</label></div><button class="primary-button" type="submit">上传并解析</button></form><div class="resource-list">${resources.map(resource=>`<article><span class="badge">${escapeHtml(courseResourceTypeLabel(resource))}</span><div><strong>${escapeHtml(resource.title||'未命名资料')}</strong><small>${escapeHtml(resource.url||'结构化数据')}</small></div></article>`).join('')||'<div class="empty-state compact-empty">该课程还没有配套资料</div>'}</div></article><article class="panel"><header class="section-head"><div><h2>${editing.id?'编辑题目':'新增题目'}</h2><p>正确选项按从 1 开始的序号填写。</p></div>${editing.id?'<button class="text-button" id="cancelQuizEdit" type="button">取消编辑</button>':''}</header><form class="quiz-editor" id="quizEditor"><label class="field"><span>题干</span><textarea class="input editor-textarea" id="quizQuestion" required>${escapeHtml(editing.question||'')}</textarea></label><label class="field"><span>选项（每行一个）</span><textarea class="input editor-textarea" id="quizOptions" required>${escapeHtml((editing.options||[]).join('\n'))}</textarea></label><div class="quiz-form-grid"><label class="field"><span>正确选项序号</span><input class="input" id="quizAnswer" type="number" min="1" value="${Number(editing.answer??0)+1}"></label><label class="field"><span>排序值</span><input class="input" id="quizSort" type="number" min="0" value="${Number(editing.sortOrder||questions.length)}"></label><label class="field"><span>状态</span><select class="select" id="quizStatus"><option value="published" ${editing.status!=='draft'?'selected':''}>已发布</option><option value="draft" ${editing.status==='draft'?'selected':''}>草稿</option></select></label></div><label class="field"><span>通用解释</span><textarea class="input" id="quizExplanation">${escapeHtml(editing.explanation||'')}</textarea></label><label class="field"><span>答题提示</span><textarea class="input" id="quizHint">${escapeHtml(editing.hint||'')}</textarea></label><button class="primary-button" type="submit">${editing.id?'保存题目':'添加题目'}</button></form></article></section><article class="panel"><header class="section-head"><div><h2>题目列表</h2><p>共 ${questions.length} 道题；发布状态决定用户是否可见。</p></div></header><div class="quiz-list">${questions.map((question,index)=>`<article class="quiz-row" data-quiz-id="${question.id}"><span class="quiz-index">${index+1}</span><div><strong>${escapeHtml(question.question)}</strong><small>${question.options.length} 个选项 · 正确答案 ${Number(question.answer)+1} · ${question.status==='draft'?'草稿':'已发布'}</small></div><button class="text-button" data-edit-quiz type="button">编辑</button><button class="text-button danger-text" data-delete-quiz type="button">删除</button></article>`).join('')||'<div class="empty-state compact-empty">该课程还没有测验题目</div>'}</div></article></section>`
}
function courseAssetWorkspace() {
  const asset=state.courseAssets
  const course=asset.courses.find(item=>Number(item.id)===Number(asset.episodeId))
  const resources=asset.resources?.resources||[]
  const attachments=asset.resources?.attachments||[]
  const questions=asset.questions||[]
  const editing=asset.editingQuestion||{}
  const attachmentAccept=asset.resources?.attachmentAccept||'.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.md,.zip,.rar,.7z'
  return `<section class="course-asset-workspace">
    <article class="panel asset-course-picker"><div class="asset-picker-body"><div class="asset-picker-copy"><span class="content-module-mark" data-icon="paperclip" aria-hidden="true"></span><div><span class="eyebrow">当前课程资源</span><h2>课件与测验工作台</h2><p>附件、题库、导图和信息图统一关联到同一门课程。</p></div></div><label class="field asset-course-select"><span>切换课程</span><select class="select" id="assetCourseSelect">${asset.courses.map(item=>`<option value="${item.id}" ${Number(item.id)===Number(asset.episodeId)?'selected':''}>${String(item.number||item.id).padStart(2,'0')} · ${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="asset-summary"><span>附件<strong>${attachments.length}</strong></span><span>题目<strong>${Number(asset.resources?.quizCount||0)}</strong></span><span>图解资料<strong>${resources.length}</strong></span><span>课程编号<strong>${course?.number||course?.id||'--'}</strong></span></div></div></article>
    <section class="course-resource-layout">
      <div class="course-resource-stack">
        <article class="panel course-attachment-admin"><header class="section-head"><div><span class="eyebrow">主站可下载</span><h2>课程附件</h2><p>支持 PDF、Office、表格、文本和压缩包；单个文件最大 20 MB。</p></div><span class="badge">${attachments.length} 个文件</span></header><form class="course-attachment-upload" id="courseAttachmentUpload"><label class="file-drop attachment-file-drop"><input id="courseAttachmentFiles" type="file" multiple accept="${escapeHtml(attachmentAccept)}"><span class="file-drop-icon" data-icon="upload" aria-hidden="true"></span><span><strong>选择要提供下载的附件</strong><small id="courseAttachmentFileLabel">一次最多 10 个文件，附件权限跟随课程</small></span></label><small class="storage-upload-provider" id="courseAttachmentStorageStatus" role="status" aria-live="polite">实际存储位置：跟随系统配置</small><div class="attachment-upload-progress" id="courseAttachmentProgress" hidden><div><span id="courseAttachmentProgressText">上传阶段：准备</span><strong id="courseAttachmentProgressPercent">0%</strong></div><progress max="100" value="0"></progress></div><button class="primary-button" type="submit"><span data-icon="upload"></span>上传附件</button></form><div class="course-attachment-admin-list">${attachments.map(attachment=>`<article class="course-attachment-admin-row" data-attachment-id="${Number(attachment.id)}"><span class="attachment-file-type">${escapeHtml(String(attachment.extension||'file').replace(/^\./,'').toUpperCase().slice(0,5))}</span><div><strong>${escapeHtml(attachment.title||attachment.file_name||'未命名附件')}</strong><small>${formatContentFileSize(attachment.file_size)} · ${escapeHtml(attachment.storage_provider&&attachment.storage_provider!=='legacy'?`实际存储：${attachment.storage_provider}`:'上传后随课程权限开放下载')}</small></div><div class="row-actions"><button class="text-button" data-download-attachment="${escapeHtml(attachment.download_url)}" data-attachment-name="${escapeHtml(attachment.file_name||attachment.title||'课程附件')}" type="button"><span data-icon="download"></span>下载</button><button class="text-button danger-text" data-delete-attachment type="button"><span data-icon="trash"></span>删除</button></div></article>`).join('')||'<div class="empty-state compact-empty"><div><strong>还没有下载附件</strong><p>上传后会自动显示在主站课程详情页。</p></div></div>'}</div></article>
        <article class="panel course-visual-assets"><header class="section-head"><div><span class="eyebrow">学习辅助内容</span><h2>题库与可视资料导入</h2><p>用于 NotebookLM 导出的题目 JSON、导图 JSON 与图片。</p></div><span class="badge">${resources.length} 份资料</span></header><form class="asset-upload-form" id="courseAssetUpload"><label class="file-drop"><input id="courseAssetFiles" type="file" multiple accept=".json,application/json,image/png,image/jpeg,image/webp"><span class="file-drop-icon" data-icon="upload" aria-hidden="true"></span><span><strong>选择 JSON 或图片文件</strong><small id="courseAssetFileLabel">最多 50 个文件；服务端按文件名与内容自动识别</small></span></label><div class="asset-type-checks"><label><input type="checkbox" id="assetIncludeQuiz" checked> 导入测验题目</label><label><input type="checkbox" id="assetIncludeMindmap" checked> 导入思维导图</label><label><input type="checkbox" id="assetIncludeInfographic" checked> 导入信息图</label></div><small class="storage-upload-provider" id="courseAssetStorageStatus">实际存储位置：跟随系统配置</small><button class="secondary-button" type="submit">上传并解析</button></form><div class="resource-list">${resources.map(resource=>`<article><span class="badge">${escapeHtml(courseResourceTypeLabel(resource))}</span><div><strong>${escapeHtml(resource.title||'未命名资料')}</strong><small>${escapeHtml(resource.url||'结构化数据')} · ${escapeHtml(resource.storage_provider&&resource.storage_provider!=='legacy'?`实际存储：${resource.storage_provider}`:'兼容旧资源')}</small></div></article>`).join('')||'<div class="empty-state compact-empty">该课程还没有导图或信息图</div>'}</div></article>
      </div>
      <article class="panel course-quiz-compose"><header class="section-head"><div><span class="eyebrow">单题维护</span><h2>${editing.id?'编辑题目':'新增题目'}</h2><p>正确选项按从 1 开始的序号填写。</p></div>${editing.id?'<button class="text-button" id="cancelQuizEdit" type="button">取消编辑</button>':''}</header><form class="quiz-editor" id="quizEditor"><label class="field"><span>题干</span><textarea class="input editor-textarea" id="quizQuestion" required>${escapeHtml(editing.question||'')}</textarea></label><label class="field"><span>选项（每行一个）</span><textarea class="input editor-textarea" id="quizOptions" required>${escapeHtml((editing.options||[]).join('\n'))}</textarea></label><div class="quiz-form-grid"><label class="field"><span>正确选项序号</span><input class="input" id="quizAnswer" type="number" min="1" value="${Number(editing.answer??0)+1}"></label><label class="field"><span>排序值</span><input class="input" id="quizSort" type="number" min="0" value="${Number(editing.sortOrder||questions.length)}"></label><label class="field"><span>状态</span><select class="select" id="quizStatus"><option value="published" ${editing.status!=='draft'?'selected':''}>已发布</option><option value="draft" ${editing.status==='draft'?'selected':''}>草稿</option></select></label></div><label class="field"><span>通用解释</span><textarea class="input" id="quizExplanation">${escapeHtml(editing.explanation||'')}</textarea></label><label class="field"><span>答题提示</span><textarea class="input" id="quizHint">${escapeHtml(editing.hint||'')}</textarea></label><button class="primary-button" type="submit">${editing.id?'保存题目':'添加题目'}</button></form></article>
    </section>
    <article class="panel course-question-library"><header class="section-head"><div><span class="eyebrow">题库明细</span><h2>题目列表</h2><p>共 ${questions.length} 道题；发布状态决定用户是否可见。</p></div><span class="badge">${questions.filter(item=>item.status!=='draft').length} 道已发布</span></header><div class="quiz-list">${questions.map((question,index)=>`<article class="quiz-row" data-quiz-id="${question.id}"><span class="quiz-index">${index+1}</span><div><strong>${escapeHtml(question.question)}</strong><small>${question.options.length} 个选项 · 正确答案 ${Number(question.answer)+1} · ${question.status==='draft'?'草稿':'已发布'}</small></div><button class="text-button" data-edit-quiz type="button">编辑</button><button class="text-button danger-text" data-delete-quiz type="button">删除</button></article>`).join('')||'<div class="empty-state compact-empty">该课程还没有测验题目</div>'}</div></article>
  </section>`
}

function uploadCourseAttachments(files,episodeId,onProgress){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest(),form=new FormData();form.append('episodeId',String(episodeId));files.forEach(file=>form.append('files',file,file.name));xhr.open('POST','/api/admin-course-attachments');if(token())xhr.setRequestHeader('Authorization',`Bearer ${token()}`);xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100))};xhr.onerror=()=>reject(new Error('附件上传网络中断'));xhr.onload=()=>{let result={};try{result=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300&&result.ok!==false)resolve(result);else{const error=new Error(result.error||'附件上传失败');error.code=result.code;reject(error)}};xhr.send(form)})}
function storageUploadProviderLabel(value){const key=String(value||'local').toLowerCase();return storageProviderLabels?.[key]||key}
function uploadQiniuBrowserFile(uploadUrl,tokenValue,objectKey,file,onProgress){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest(),form=new FormData();form.append('token',tokenValue);form.append('key',objectKey);form.append('file',file,file.name);xhr.open('POST',uploadUrl);xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress?.(Math.round(event.loaded/event.total*100))};xhr.onerror=()=>reject(new Error('七牛直传网络中断'));xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)resolve(xhr);else reject(new Error('七牛直传上传失败'))};xhr.send(form)})}
async function uploadQiniuAdminFile(file,episodeId,onProgress){const session=await api('/api/admin-course-attachments/upload-session',{method:'POST',body:JSON.stringify({episodeId,originalName:file.name,mimeType:file.type,sizeBytes:file.size})});if(session.provider!=='qiniu'||!session.uploadUrl||!session.token)throw new Error('七牛直传会话无效');await uploadQiniuBrowserFile(session.uploadUrl,session.token,session.objectKey,file,onProgress);const confirmed=await api('/api/admin-course-attachments/confirm',{method:'POST',body:JSON.stringify({episodeId,sessionId:session.sessionId,key:session.objectKey})});onProgress?.(100);return confirmed}
async function uploadCourseAttachmentsForProvider(files,episodeId,provider,onProgress){if(provider!=='qiniu')return uploadCourseAttachments(files,episodeId,onProgress);const attachments=[];for(let i=0;i<files.length;i++){const result=await uploadQiniuAdminFile(files[i],episodeId,value=>onProgress(Math.round(((i+value/100)/files.length)*100)));if(!result.ok)throw new Error(result.error||'七牛附件确认失败');if(result.attachment)attachments.push(result.attachment)}return {ok:true,attachments,storage_provider:'qiniu',upload_phase:'confirmed'}}
async function uploadQiniuAdminResourceFile(file,episodeId,resourceType,onProgress){const session=await api('/api/admin-course-resources/upload-session',{method:'POST',body:JSON.stringify({episodeId,resourceType,originalName:file.name,mimeType:file.type,sizeBytes:file.size})});if(session.provider!=='qiniu'||!session.uploadUrl||!session.token)throw new Error('七牛直传会话无效');await uploadQiniuBrowserFile(session.uploadUrl,session.token,session.objectKey,file,onProgress);onProgress?.('服务端确认');return api('/api/admin-course-resources/confirm',{method:'POST',body:JSON.stringify({episodeId,resourceType,title:file.name.replace(/\.[^.]+$/,''),sessionId:session.sessionId,key:session.objectKey})})}
async function uploadCourseResourcesForProvider(files,episodeId,providers,{includeQuiz,includeMindmap,includeInfographic,onPhase}={}){const imageProvider=providers?.image||'local';const imageFiles=files.filter(file=>/\.(png|jpe?g|webp|gif)$/i.test(file.name));const serverFiles=imageProvider==='qiniu'?files.filter(file=>!imageFiles.includes(file)):files;let result={ok:true,quizFiles:0,assetFiles:0,skipped:[],storage_provider:imageProvider,upload_phase:'confirmed'};if(serverFiles.length){const form=new FormData();form.append('episodeId',String(episodeId));form.append('includeQuiz',includeQuiz?'1':'0');form.append('includeMindmap',includeMindmap?'1':'0');form.append('includeInfographic',includeInfographic?'1':'0');serverFiles.forEach(file=>form.append('files',file,file.webkitRelativePath||file.name));result=await api('/api/admin-course-resources',{method:'POST',body:form});if(!result.ok)return result}if(imageProvider==='qiniu'){for(const file of imageFiles){const namedMindmap=/mindmap|structure|导图|思维/i.test(file.name);const resourceType=namedMindmap&&includeMindmap?'mindmap':includeInfographic?'knowledge':'mindmap';onPhase?.('七牛直传中');const confirmed=await uploadQiniuAdminResourceFile(file,episodeId,resourceType,phase=>onPhase?.(phase));if(!confirmed.ok)throw new Error(confirmed.error||'七牛资源确认失败');result.assetFiles=Number(result.assetFiles||0)+1}result.storage_provider='qiniu';result.upload_phase='confirmed'}return result}
async function downloadAdminCourseAttachment(url,fileName,button){const label=button.innerHTML;button.disabled=true;button.textContent='准备下载…';try{const headers={};if(token())headers.Authorization=`Bearer ${token()}`;const response=await fetch(url,{headers});if(!response.ok){let data={};try{data=await response.json()}catch{}throw new Error(data.error||'附件下载失败')}const objectUrl=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=objectUrl;link.download=fileName||'课程附件';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000)}finally{button.disabled=false;button.innerHTML=label;renderIcons(button)}}

async function loadCourseAssets() {
  const asset=state.courseAssets
  if(!asset.courses.length){const data=await api('/api/admin/content-system/courses?page=1&page_size=100&status=all');asset.courses=data.courses||[];asset.episodeId=Number(asset.episodeId||asset.courses[0]?.id||0)}
  if(!asset.episodeId){document.querySelector('#contentSystemBody').innerHTML='<div class="panel"><div class="empty-state">请先创建一门课程</div></div>';return}
  const [resources,quiz]=await Promise.all([api(`/api/admin-course-resources?episode=${asset.episodeId}`),api(`/api/admin-quiz?episode=${asset.episodeId}`)])
  asset.resources=resources;asset.questions=quiz.questions||[]
  renderCourseAssets()
}
function renderCourseAssets() {
  const root=document.querySelector('#contentSystemBody');root.innerHTML=courseAssetWorkspace();renderIcons(root);const asset=state.courseAssets;const effective=asset.resources?.effective_providers||{};const attachmentProvider=effective.attachment||'local';const imageProvider=effective.image||'local';root.querySelector('#courseAttachmentStorageStatus').textContent=`实际存储位置：${storageUploadProviderLabel(attachmentProvider)}（由系统设置决定）`;root.querySelector('#courseAssetStorageStatus').textContent=`实际存储位置：${storageUploadProviderLabel(imageProvider)}（由系统设置决定）`
  root.querySelector('#assetCourseSelect').onchange=async event=>{asset.episodeId=Number(event.target.value);asset.editingQuestion=null;await loadCourseAssets().catch(handleError)}
  root.querySelector('#courseAttachmentFiles').onchange=event=>{const files=[...event.target.files],label=root.querySelector('#courseAttachmentFileLabel');label.textContent=files.length?`已选择 ${files.length} 个文件 · 共 ${formatContentFileSize(files.reduce((sum,file)=>sum+file.size,0))}`:'一次最多 10 个文件，附件权限跟随课程'}
  root.querySelector('#courseAttachmentUpload').onsubmit=async event=>{event.preventDefault();const files=[...root.querySelector('#courseAttachmentFiles').files];if(!files.length)return handleError(new Error('请选择要上传的附件'));const oversized=files.find(file=>file.size>20*1024*1024);if(oversized)return handleError(new Error(`${oversized.name} 超过 20 MB`));const button=event.submitter,progress=root.querySelector('#courseAttachmentProgress'),bar=progress.querySelector('progress'),percent=root.querySelector('#courseAttachmentProgressPercent'),status=root.querySelector('#courseAttachmentProgressText'),providerLabel=root.querySelector('#courseAttachmentStorageStatus'),provider=asset.resources?.effective_providers?.attachment||'local';button.disabled=true;progress.hidden=false;try{const result=await uploadCourseAttachmentsForProvider(files,asset.episodeId,provider,value=>{bar.value=value;percent.textContent=`${value}%`;status.textContent=value<100?'上传阶段：传输中':'上传阶段：确认中'});providerLabel.textContent=`实际存储位置：${storageUploadProviderLabel(result.storage_provider||provider)} · 上传阶段：已确认`;status.textContent='上传阶段：已确认';const skipped=Array.isArray(result.skipped)?result.skipped.length:0;toast(`已上传 ${result.attachments?.length||files.length} 个附件${skipped?`，跳过 ${skipped} 个`:''}`,'success');await Promise.all([loadCourseAssets(),loadContentOverview()])}catch(error){status.textContent='上传阶段：失败';handleError(error);button.disabled=false}}
  root.querySelectorAll('[data-download-attachment]').forEach(button=>button.onclick=async()=>{try{await downloadAdminCourseAttachment(button.dataset.downloadAttachment,button.dataset.attachmentName,button)}catch(error){handleError(error)}})
  root.querySelectorAll('[data-delete-attachment]').forEach(button=>button.onclick=async()=>{const row=button.closest('[data-attachment-id]'),attachmentId=Number(row.dataset.attachmentId);if(!await confirmAction('删除这个课程附件？','主站课程详情页将立即停止提供该文件，删除后无法恢复。','确认删除',true))return;button.disabled=true;try{await api(`/api/admin-course-attachments/${attachmentId}`,{method:'DELETE'});toast('课程附件已删除','success');await Promise.all([loadCourseAssets(),loadContentOverview()])}catch(error){handleError(error);button.disabled=false}})
  root.querySelector('#courseAssetFiles').onchange=event=>{const count=event.target.files.length;root.querySelector('#courseAssetFileLabel').textContent=count?`已选择 ${count} 个文件`:'最多 50 个文件；服务端按文件名与内容自动识别'}
  // Override the legacy multipart handler with a provider-aware dispatcher:
  // qiniu image files never enter the website multipart request. JSON quiz
  // files may still use the server parser (and structure JSON is DB-only
  // when resource_provider=qiniu).
  root.querySelector('#courseAssetUpload').onsubmit=async event=>{event.preventDefault();const files=[...root.querySelector('#courseAssetFiles').files];if(!files.length)return handleError(new Error('请选择要导入的 JSON 或图片文件'));const button=event.submitter,includeQuiz=root.querySelector('#assetIncludeQuiz').checked,includeMindmap=root.querySelector('#assetIncludeMindmap').checked,includeInfographic=root.querySelector('#assetIncludeInfographic').checked,providerMap=asset.resources?.effective_providers||{};button.disabled=true;try{const result=await uploadCourseResourcesForProvider(files,asset.episodeId,providerMap,{includeQuiz,includeMindmap,includeInfographic,onPhase:phase=>{root.querySelector('#courseAssetStorageStatus').textContent=`实际存储位置：${storageUploadProviderLabel(providerMap.image||'local')} · 上传阶段：${phase}`}});const provider=result.storage_provider||providerMap.image||'local';root.querySelector('#courseAssetStorageStatus').textContent=`实际存储位置：${storageUploadProviderLabel(provider)} · 上传阶段：${result.upload_phase==='confirmed'?'已确认':'完成'}`;const skipped=Array.isArray(result.skipped)?result.skipped.length:0;toast(`导入完成：题库文件 ${Number(result.quizFiles||0)}，资料文件 ${Number(result.assetFiles||0)}${skipped?`，跳过 ${skipped}`:''}`,'success');await loadCourseAssets()}catch(error){root.querySelector('#courseAssetStorageStatus').textContent='实际存储位置：上传失败';handleError(error);button.disabled=false}}
  root.querySelector('#cancelQuizEdit')?.addEventListener('click',()=>{asset.editingQuestion=null;renderCourseAssets()})
  root.querySelector('#quizEditor').onsubmit=async event=>{event.preventDefault();const options=root.querySelector('#quizOptions').value.split('\n').map(value=>value.trim()).filter(Boolean);if(options.length<2)return handleError(new Error('一道题至少需要 2 个选项'));const correctIndex=Number(root.querySelector('#quizAnswer').value)-1;if(correctIndex<0||correctIndex>=options.length)return handleError(new Error('正确选项序号超出选项范围'));const button=event.submitter;button.disabled=true;try{await api('/api/admin-quiz',{method:'POST',body:JSON.stringify({id:asset.editingQuestion?.id||undefined,episodeId:asset.episodeId,question:root.querySelector('#quizQuestion').value.trim(),options,correctIndex,explanation:root.querySelector('#quizExplanation').value.trim(),explanations:[],hint:root.querySelector('#quizHint').value.trim(),status:root.querySelector('#quizStatus').value,sortOrder:Number(root.querySelector('#quizSort').value||0)})});toast(asset.editingQuestion?'题目已保存':'题目已添加','success');asset.editingQuestion=null;await loadCourseAssets()}catch(error){handleError(error);button.disabled=false}}
  root.querySelectorAll('[data-edit-quiz]').forEach(button=>button.onclick=()=>{const id=Number(button.closest('[data-quiz-id]').dataset.quizId);asset.editingQuestion=asset.questions.find(item=>Number(item.id)===id)||null;renderCourseAssets();root.querySelector('#quizQuestion')?.focus()})
  root.querySelectorAll('[data-delete-quiz]').forEach(button=>button.onclick=async()=>{const id=Number(button.closest('[data-quiz-id]').dataset.quizId);if(!await confirmAction('删除这道题？','删除后无法恢复，但不会影响课程主体和其他资料。','确认删除',true))return;try{await api(`/api/admin-quiz?id=${id}`,{method:'DELETE'});toast('题目已删除','success');await loadCourseAssets()}catch(error){handleError(error)}})
}
async function renderContentFeedback(){
  const params=new URLSearchParams({page:String(state.feedbackPage),page_size:'20'})
  if(state.feedbackSearch)params.set('search',state.feedbackSearch)
  const data=await api(`/api/admin/content-system/feedback?${params}`),root=document.querySelector('#contentSystemBody'),total=Number(data.pagination.total||0)
  root.innerHTML=`<section class="panel content-feedback-panel">
    <header class="content-feedback-head"><div><span class="content-panel-icon" data-icon="message" aria-hidden="true"></span><div><span class="eyebrow">用户声音</span><h2>反馈收件箱</h2><p>集中查看课程建议、使用问题和用户联系方式。</p></div></div><span class="content-panel-count"><strong>${total.toLocaleString('zh-CN')}</strong>条反馈</span></header>
    <form class="content-feedback-toolbar" id="feedbackFilters"><label class="content-search-field" for="feedbackSearch"><span data-icon="search" aria-hidden="true"></span><input class="input" id="feedbackSearch" value="${escapeHtml(state.feedbackSearch)}" placeholder="搜索标题、内容、联系方式或用户"><small>Enter</small></label><button class="secondary-button" type="submit"><span data-icon="search" aria-hidden="true"></span>搜索反馈</button>${state.feedbackSearch?'<button class="text-button" id="feedbackClear" type="button">清除筛选</button>':''}</form>
    <div class="feedback-list">${data.feedback.map(item=>`<article class="feedback-card"><header><div><span class="badge">${escapeHtml(item.type||'建议')}</span><strong>${escapeHtml(item.title||'未命名反馈')}</strong></div><time datetime="${escapeHtml(item.created_at||'')}">${formatDate(item.created_at,true)}</time></header><p>${escapeHtml(item.description||'未填写详细内容')}</p><footer><span data-icon="users" aria-hidden="true"></span><strong>${escapeHtml(item.user_nickname||item.user_email||'匿名用户')}</strong><i></i><span>${escapeHtml(item.contact||'未留联系方式')}</span></footer></article>`).join('')||`<div class="empty-state content-feedback-empty"><span class="content-empty-icon" data-icon="message" aria-hidden="true"></span><div><strong>${state.feedbackSearch?'没有匹配的用户反馈':'暂时没有用户反馈'}</strong><p>${state.feedbackSearch?'换一个关键词，或清除筛选查看全部反馈。':'新反馈提交后会在这里按时间倒序出现。'}</p></div>${state.feedbackSearch?'<button class="secondary-button" id="feedbackEmptyClear" type="button">清除筛选</button>':''}</div>`}</div>
    <footer class="pagination content-pagination"><button class="secondary-button" id="feedbackPrev" type="button">上一页</button><span>第 <strong>${data.pagination.page}</strong> / ${data.pagination.total_pages} 页 · 共 ${total.toLocaleString('zh-CN')} 条</span><button class="secondary-button" id="feedbackNext" type="button">下一页</button></footer>
  </section>`
  renderIcons(root)
  root.querySelector('#feedbackFilters').onsubmit=e=>{e.preventDefault();state.feedbackSearch=root.querySelector('#feedbackSearch').value.trim();state.feedbackPage=1;renderContentFeedback().catch(handleError)}
  const clear=()=>{state.feedbackSearch='';state.feedbackPage=1;renderContentFeedback().catch(handleError)}
  root.querySelector('#feedbackClear')?.addEventListener('click',clear)
  root.querySelector('#feedbackEmptyClear')?.addEventListener('click',clear)
  root.querySelector('#feedbackPrev').disabled=data.pagination.page<=1
  root.querySelector('#feedbackNext').disabled=data.pagination.page>=data.pagination.total_pages
  root.querySelector('#feedbackPrev').onclick=()=>{state.feedbackPage--;renderContentFeedback().catch(handleError)}
  root.querySelector('#feedbackNext').onclick=()=>{state.feedbackPage++;renderContentFeedback().catch(handleError)}
}
const systemCategoryMeta={
  auth_toggle:{label:'登录与注册',description:'管理登录方式及新用户注册赠送权益。',icon:'users',tone:'sensitive',toneLabel:'用户权限'},
  plan_prices:{label:'套餐价格',description:'维护 Plus 与 Pro 的月付、年付价格。',icon:'commercial',tone:'sensitive',toneLabel:'商业配置'},
  crypto_wallet:{label:'TRC-20 收款',description:'维护固定 TRON 收款地址；当前不开放动态地址与其他网络。',icon:'wallet',tone:'critical',toneLabel:'资金配置'},
  sms:{label:'短信服务',description:'配置短信签名、验证码和会员提醒模板。',icon:'phone',tone:'sensitive',toneLabel:'敏感配置'},
  smtp:{label:'发件邮箱',description:'配置平台通知邮件的发送服务。',icon:'mail',tone:'sensitive',toneLabel:'敏感配置'},
  qiniu:{label:'七牛连接',description:'维护私有对象存储的连接凭证与访问域名。',icon:'cloud',tone:'sensitive',toneLabel:'敏感配置'},
  media_storage:{label:'文件与媒体存储',description:'推荐七牛，但初始配置保持本地；连接测试通过后再启用。',icon:'archive',tone:'standard',toneLabel:'存储配置'},
  market_menu:{label:'股票研究菜单',description:'维护主站股票研究入口及展示顺序。',icon:'chart',tone:'standard',toneLabel:'展示配置'},
  toolbox:{label:'金融工具箱',description:'维护主站金融工具、链接与说明。',icon:'archive',tone:'standard',toneLabel:'展示配置'},
  changelog:{label:'版本说明',description:'主站与 AI 实验室共用的版本信息。',icon:'file',tone:'standard',toneLabel:'发布配置'},
}
const systemCategoryOrder=['auth_toggle','plan_prices','crypto_wallet','media_storage','qiniu','sms','smtp','market_menu','toolbox']
const systemCategoryLabels=Object.fromEntries(Object.entries(systemCategoryMeta).map(([key,value])=>[key,value.label]))
const systemConfigKeyLabels={
  enable_email_login:'允许邮箱登录',enable_phone_register:'允许手机号注册',enable_phone_login:'允许手机号登录',
  enable_email_register:'允许邮箱注册',email_enabled:'邮箱注册登录',phone_enabled:'手机号注册登录',gift_enabled:'注册赠送会员',gift_plan:'赠送套餐类型',gift_duration:'赠送时长',gift_duration_unit:'赠送时长单位',
  host:'邮件服务器地址',port:'邮件服务端口',user:'邮件账户',pass:'邮件密码',from:'发件邮箱',from_name:'发件人名称',secure:'启用安全连接',
  access_key:'存储访问密钥',secret_key:'存储私密密钥',bucket:'存储桶名称',domain:'访问域名',region:'存储区域',private_bucket:'私有空间',
  default_provider:'默认存储位置',video_provider:'课程视频存储位置',attachment_provider:'课程附件存储位置',image_provider:'图片存储位置',resource_provider:'其他资源存储位置',local_root:'本地存储目录',qiniu_connection_test_version:'连接测试配置版本',qiniu_connection_test_status:'连接测试状态',qiniu_connection_test_stage:'连接测试阶段',qiniu_connection_tested_at:'最近测试时间',qiniu_connection_test_error:'连接测试安全错误',qiniu_connection_test_cleanup_pending:'测试对象待清理',
  access_key_id:'短信访问密钥 ID',access_key_secret:'短信访问密钥',sign_name:'短信签名',template_code:'通用验证码模板',test_phone:'默认测试手机号',template_code_login:'登录验证码模板',template_code_register:'注册验证码模板',template_code_reset:'重置密码模板',template_code_bind:'绑定验证码模板',template_code_membership_expiry:'会员到期模板',template_code_membership_expired:'会员过期模板',
  payment_mode:'支付模式',hd_mnemonic:'地址派生助记词',trongrid_api_key:'TRON 网络接口密钥',etherscan_api_key:'以太坊网络接口密钥',bscscan_api_key:'BSC 网络接口密钥',solana_rpc_url:'Solana 网络接口地址',rate_source:'汇率来源',fixed_tron_address:'固定 TRON 收款地址',fixed_erc20_address:'固定 ERC-20 收款地址',fixed_bep20_address:'固定 BEP-20 收款地址',fixed_sol_address:'固定 Solana 收款地址',items:'配置项目',
  plus_month:'Plus 月付价',plus_month_original:'Plus 月付原价',plus_year:'Plus 年付价',plus_year_original:'Plus 年付原价',
  pro_month:'Pro 月付价',pro_month_original:'Pro 月付原价',pro_year:'Pro 年付价',pro_year_original:'Pro 年付原价',
}
const systemConfigKeyHelp={
  enable_email_register:'关闭后将隐藏邮箱注册入口。',enable_email_login:'关闭后已有用户也不能使用邮箱登录。',enable_phone_register:'关闭后将隐藏手机号注册入口。',enable_phone_login:'关闭后已有用户也不能使用手机号登录。',
  email_enabled:'同时控制邮箱注册与登录入口。',phone_enabled:'同时控制手机号注册与登录入口。',gift_enabled:'开启后，新注册用户会按下方规则获得会员。',gift_plan:'选择注册赠送的会员等级。',gift_duration:'填写赠送权益的有效时长。',gift_duration_unit:'设置赠送时长使用的计算单位。',
  payment_mode:'生产支付链路固定为 TRC-20 共享地址，不支持在管理台切换。',fixed_tron_address:'订单通过固定地址和金额尾差进行匹配，请使用有效 TRON 地址。',hd_mnemonic:'用于派生动态收款地址，留空会保留现有助记词。',rate_source:'用于订单金额换算的汇率数据来源。',
  region:'请选择对象存储空间所在区域。',domain:'填写 HTTPS 访问域名，只填写域名根地址。',secure:'465 端口通常开启，587 端口通常关闭。',
  default_provider:'只影响之后的新上传文件，已有文件不会自动迁移。',video_provider:'选择 inherit 时跟随默认存储位置。',attachment_provider:'选择 inherit 时跟随默认存储位置。',image_provider:'选择 inherit 时跟随默认存储位置。',resource_provider:'选择 inherit 时跟随默认存储位置。',local_root:'由服务器环境固定，后台只读；配置切换不会移动已有文件。',qiniu_connection_test_status:'只有当前配置版本测试通过后才能启用七牛。',qiniu_connection_test_stage:'显示最近一次连接测试停留的阶段。',qiniu_connection_tested_at:'测试结果带时间，过期后不能视为当前事实。',qiniu_connection_test_error:'仅显示安全错误分类，不包含 SDK 响应或凭证。',qiniu_connection_test_cleanup_pending:'测试对象删除失败时保持待清理标记，不会显示为通过。',
  template_code:'未指定场景模板时使用的兼容模板。',test_phone:'仅用于后台测试，不会展示给用户。',items:'使用结构化表单维护内容；页面从上到下的顺序会同步到主站。',
}
const systemConfigSelectOptions={
  gift_plan:[['free','免费用户'],['plus','Plus 进阶版'],['pro','Pro 专业版']],
  gift_duration_unit:[['days','天'],['months','月'],['years','年']],
  payment_mode:[['fixed','固定 TRC-20 地址']],
  region:[['z0','华东 z0'],['z1','华北 z1'],['z2','华南 z2'],['na0','北美 na0'],['as0','东南亚 as0'],['cn-east','旧配置 cn-east'],['cn-south','旧配置 cn-south']],
  default_provider:[['local','本地存储'],['qiniu','七牛云']],
  video_provider:[['inherit','继承默认'],['local','本地存储'],['qiniu','七牛云']],
  attachment_provider:[['inherit','继承默认'],['local','本地存储'],['qiniu','七牛云']],
  image_provider:[['inherit','继承默认'],['local','本地存储'],['qiniu','七牛云']],
  resource_provider:[['inherit','继承默认'],['local','本地存储'],['qiniu','七牛云']],
}
const sensitiveConfigKeyRe=/(mnemonic|private_key|secret|password|access_key|api_key|rpc_url|(^|_)pass($|_)|(^|_)token($|_))/i
function configItemLabel(item){
  const key=String(item?.key||'')
  if(systemConfigKeyLabels[key])return systemConfigKeyLabels[key]
  const symbolMatch=key.match(/^quote_symbol_(\d+)$/)
  if(symbolMatch)return `用户 #${symbolMatch[1]} 行情品种`
  const label=String(item?.label||'').trim()
  return label&&/[\u4e00-\u9fff]/.test(label)?label:'未命名配置'
}
function isSensitiveConfigKey(key){return sensitiveConfigKeyRe.test(String(key||''))}
function systemConfigControlId(item,index){return `systemConfig_${String(item.key||index).replace(/[^a-zA-Z0-9_-]/g,'_')}_${index}`}
function structuredConfigExtra(value,knownKeys){return Object.fromEntries(Object.entries(value||{}).filter(([key])=>!knownKeys.includes(key)))}
function structuredConfigExtraAttribute(value,knownKeys){return escapeHtml(JSON.stringify(structuredConfigExtra(value,knownKeys)))}
function structuredConfigField(label,key,value='',options={}){
  const multiline=Boolean(options.multiline),required=Boolean(options.required),type=options.type||'text',placeholder=options.placeholder||''
  return `<label class="structured-config-field ${multiline?'is-wide':''}"><span>${escapeHtml(label)}${required?'<b>必填</b>':''}</span>${multiline?`<textarea class="input" data-structured-field="${escapeHtml(key)}" rows="2" placeholder="${escapeHtml(placeholder)}" ${required?'required':''}>${escapeHtml(value)}</textarea>`:`<input class="input" data-structured-field="${escapeHtml(key)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${required?'required':''}>`}</label>`
}
function marketMenuItemHtml(item={},index=0){
  const known=['name','icon','url']
  return `<article class="structured-config-item" data-structured-item data-extra="${structuredConfigExtraAttribute(item,known)}"><header><span class="structured-config-index">${index+1}</span><div><strong>${escapeHtml(item.name||'新菜单项')}</strong><small>股票研究入口</small></div><div class="structured-config-row-actions"><button type="button" data-structured-move="up" aria-label="上移菜单项">↑</button><button type="button" data-structured-move="down" aria-label="下移菜单项">↓</button><button class="is-danger" type="button" data-structured-remove aria-label="删除菜单项"><span data-icon="trash"></span></button></div></header><div class="structured-config-grid">${structuredConfigField('名称','name',item.name,{required:true,placeholder:'例如：全球市场股票深度研究'})}${structuredConfigField('图标','icon',item.icon,{placeholder:'例如：📈'})}${structuredConfigField('访问地址','url',item.url,{required:true,placeholder:'/research/ 或 https://…'})}</div></article>`
}
function toolboxItemHtml(item={},index=0){
  const known=['name','desc','icon','url','tag','tagColor','code','rebate','note']
  return `<article class="structured-config-item toolbox-config-item" data-structured-item data-extra="${structuredConfigExtraAttribute(item,known)}"><header><span class="structured-config-index">${index+1}</span><div><strong>${escapeHtml(item.name||'新工具')}</strong><small>${escapeHtml(item.url||'尚未填写链接')}</small></div><div class="structured-config-row-actions"><button type="button" data-structured-move="up" aria-label="上移工具">↑</button><button type="button" data-structured-move="down" aria-label="下移工具">↓</button><button class="is-danger" type="button" data-structured-remove aria-label="删除工具"><span data-icon="trash"></span></button></div></header><div class="structured-config-grid">${structuredConfigField('工具名称','name',item.name,{required:true,placeholder:'例如：TradingView'})}${structuredConfigField('图标','icon',item.icon,{placeholder:'例如：📊'})}${structuredConfigField('访问地址','url',item.url,{required:true,placeholder:'https://…'})}${structuredConfigField('简要说明','desc',item.desc,{multiline:true,placeholder:'向用户说明工具用途'})}</div><details class="structured-config-details"><summary>推广与补充信息</summary><div class="structured-config-grid">${structuredConfigField('角标文字','tag',item.tag,{placeholder:'例如：首选'})}${structuredConfigField('角标颜色','tagColor',item.tagColor,{placeholder:'#f0b90b'})}${structuredConfigField('邀请码','code',item.code,{placeholder:'选填'})}${structuredConfigField('返佣说明','rebate',item.rebate,{placeholder:'例如：返佣 20%'})}${structuredConfigField('补充提示','note',item.note,{multiline:true,placeholder:'选填，将展示给用户'})}</div></details></article>`
}
function toolboxGroupHtml(group={},index=0){
  const items=Array.isArray(group.items)?group.items:[],known=['category','items']
  return `<section class="structured-config-group" data-structured-group data-extra="${structuredConfigExtraAttribute(group,known)}"><header class="structured-config-group-head"><span class="structured-config-index">${index+1}</span><label><span>分类名称 <b>必填</b></span><input class="input" data-structured-category required value="${escapeHtml(group.category||'')}" placeholder="例如：数据工具"></label><div class="structured-config-row-actions"><button type="button" data-structured-group-move="up" aria-label="上移分类">↑</button><button type="button" data-structured-group-move="down" aria-label="下移分类">↓</button><button class="is-danger" type="button" data-structured-group-remove aria-label="删除分类"><span data-icon="trash"></span></button></div></header><div class="structured-config-items">${items.map(toolboxItemHtml).join('')}</div><button class="structured-config-add" type="button" data-structured-add-item><span data-icon="plus"></span>添加工具</button></section>`
}
function structuredConfigInput(category,item,index){
  const id=systemConfigControlId(item,index),value=String(item.value??'')
  let parsed
  try{parsed=JSON.parse(value||'[]')}catch{return `<div class="structured-config-invalid"><strong>现有内容无法转换为表单</strong><small>请先修正下面的 JSON，保存后即可使用可视化编辑器。</small><textarea class="input config-json-input" id="${id}" data-config-key="${escapeHtml(item.key)}" spellcheck="false" aria-describedby="${id}_error">${escapeHtml(value)}</textarea></div>`}
  if(!Array.isArray(parsed))return `<textarea class="input config-json-input" id="${id}" data-config-key="${escapeHtml(item.key)}" spellcheck="false" aria-describedby="${id}_error">${escapeHtml(value)}</textarea>`
  const content=category==='market_menu'?`<div class="structured-config-items">${parsed.map(marketMenuItemHtml).join('')}</div><button class="structured-config-add" type="button" data-structured-add-item><span data-icon="plus"></span>添加菜单项</button>`:`<div class="structured-config-groups">${parsed.map(toolboxGroupHtml).join('')}</div><button class="structured-config-add is-group" type="button" data-structured-add-group><span data-icon="plus"></span>添加工具分类</button>`
  return `<div class="structured-config-editor" data-structured-config="${escapeHtml(category)}"><textarea class="structured-config-value" id="${id}" data-config-key="${escapeHtml(item.key)}" aria-describedby="${id}_error">${escapeHtml(value)}</textarea><div class="structured-config-toolbar"><div><strong>${category==='market_menu'?'菜单条目':'工具分类与条目'}</strong><small>使用上移、下移调整主站展示顺序</small></div><span data-structured-count></span></div>${content}</div>`
}
const storageProviderKeys=new Set(['default_provider','video_provider','attachment_provider','image_provider','resource_provider'])
const storageProviderLabels={local:'本地存储',qiniu:'七牛云',inherit:'继承默认'}
function storageProviderValue(key,value,items){
  const map=Object.fromEntries((items||[]).map(item=>[item.key,String(item.value??'')]))
  const selected=String(value||map[key]||'inherit')
  return selected==='inherit'?String(map.default_provider||'local'):selected
}
function storageProviderItemsForRoot(root=document){
  const map=Object.fromEntries((state.systemConfig?.media_storage||[]).map(item=>[item.key,String(item.value??'')]))
  root.querySelectorAll?.('[data-storage-provider]').forEach(control=>{map[control.dataset.configKey]=String(control.value??'')})
  return Object.entries(map).map(([key,value])=>({key,value}))
}
function storageProviderControlHtml(item,index,id,value){
  const effective=storageProviderValue(item.key,value,state.systemConfig?.media_storage||[])
  const options=systemConfigSelectOptions[item.key]||[]
  return `<div class="storage-provider-control"><select class="select" id="${id}" data-config-key="${escapeHtml(item.key)}" data-storage-provider="true">${options.map(([optionValue,optionLabel])=>`<option value="${optionValue}" ${value===optionValue?'selected':''}>${optionLabel}</option>`).join('')}</select><small data-effective-provider="${escapeHtml(item.key)}">当前生效：${escapeHtml(storageProviderLabels[effective]||effective)}</small></div>`
}
function refreshStorageEffectiveProviders(root=document){
  const items=storageProviderItemsForRoot(root)
  root.querySelectorAll('[data-storage-provider]').forEach(control=>{
    const target=root.querySelector(`[data-effective-provider="${CSS.escape(control.dataset.configKey||'')}"]`)
    if(target){const effective=storageProviderValue(control.dataset.configKey,control.value,items);target.textContent=`当前生效：${storageProviderLabels[effective]||effective}`}
  })
}
function systemConfigInput(item,index,category='') {
  const value=String(item.value??''),key=String(item.key||''),id=systemConfigControlId(item,index)
  const meta=item.config_meta||{},sensitive=Boolean(meta.sensitive)||isSensitiveConfigKey(key),stored=value==='***REDACTED***'
  if(meta.editable===false)return `<div class="config-readonly-value"><strong>${escapeHtml(systemConfigSelectOptions[key]?.find(option=>option[0]===value)?.[1]||value||'系统固定')}</strong><small>由服务端执行合约锁定</small></div>`
  const isBoolean=['true','false'].includes(value)
  const isJson=['items'].includes(key)||value.trim().startsWith('[')||value.trim().startsWith('{')
  const selectOptions=systemConfigSelectOptions[key]
  if(category==='media_storage'&&storageProviderKeys.has(key))return storageProviderControlHtml(item,index,id,value)
  if(sensitive){const encryptionReady=state.systemConfigSecurity?.credential_encryption_available!==false;return `<div class="config-secret-control"><div class="config-secret-state ${stored?'is-set':'is-empty'}"><span data-icon="${stored?'check':'key'}" aria-hidden="true"></span><strong>${stored?'已加密保存':'尚未配置'}</strong><small>${encryptionReady?(stored?'留空不会覆盖现有内容':'保存时使用 AES-256-GCM 加密'):'凭证加密服务未就绪'}</small></div><input class="input" id="${id}" type="password" autocomplete="new-password" data-config-key="${escapeHtml(key)}" data-redacted="true" value="" placeholder="${stored?'输入新内容可替换':'请输入配置内容'}" ${encryptionReady?'':'disabled'}></div>`}
  if(isBoolean)return `<label class="config-toggle-control" for="${id}"><input id="${id}" type="checkbox" data-config-key="${escapeHtml(key)}" data-config-boolean="true" ${value==='true'?'checked':''}><span class="config-toggle-track" aria-hidden="true"><span></span></span><strong data-config-toggle-label>${value==='true'?'已开启':'已关闭'}</strong></label>`
  if(selectOptions)return `<select class="select" id="${id}" data-config-key="${escapeHtml(key)}">${selectOptions.map(([optionValue,optionLabel])=>`<option value="${optionValue}" ${value===optionValue?'selected':''}>${optionLabel}</option>`).join('')}</select>`
  if(isJson&&key==='items'&&['market_menu','toolbox'].includes(category))return structuredConfigInput(category,item,index)
  if(isJson)return `<textarea class="input config-json-input" id="${id}" data-config-key="${escapeHtml(key)}" spellcheck="false" aria-describedby="${id}_error">${escapeHtml(value)}</textarea>`
  const numeric=meta.type==='integer'||/(_month|_year|_original|duration$|^port$)/.test(key)
  const inputType=key==='from'?'email':key==='test_phone'?'tel':numeric?'number':'text'
  const numericAttrs=numeric?` min="${Number.isFinite(Number(meta.min))?Number(meta.min):0}"${Number.isFinite(Number(meta.max))?` max="${Number(meta.max)}"`:''} step="1" inputmode="decimal"`:''
  return `<input class="input" id="${id}" type="${inputType}" data-config-key="${escapeHtml(key)}" value="${escapeHtml(value)}"${numericAttrs}${category==='plan_prices'?` required aria-describedby="${id}_error"`:''}>`
}
function structuredConfigNodeValue(node){
  let value={}
  try{value=JSON.parse(node.dataset.extra||'{}')}catch{}
  node.querySelectorAll(':scope [data-structured-field]').forEach(field=>{if(field.closest('[data-structured-item]')===node){const fieldValue=field.value.trim();if(fieldValue)value[field.dataset.structuredField]=fieldValue}})
  return value
}
function syncStructuredConfig(editor){
  const category=editor.dataset.structuredConfig,control=editor.querySelector('.structured-config-value');let value=[]
  if(category==='market_menu'){
    value=[...editor.querySelectorAll(':scope > .structured-config-items > [data-structured-item]')].map(structuredConfigNodeValue)
  }else{
    value=[...editor.querySelectorAll(':scope > .structured-config-groups > [data-structured-group]')].map(group=>{
      let result={};try{result=JSON.parse(group.dataset.extra||'{}')}catch{}
      result.category=group.querySelector(':scope > .structured-config-group-head [data-structured-category]')?.value.trim()||''
      result.items=[...group.querySelectorAll(':scope > .structured-config-items > [data-structured-item]')].map(structuredConfigNodeValue)
      return result
    })
  }
  control.value=JSON.stringify(value)
}
function refreshStructuredConfigEditor(editor){
  const category=editor.dataset.structuredConfig,groups=[...editor.querySelectorAll(':scope > .structured-config-groups > [data-structured-group]')]
  const refreshItems=container=>{const items=[...container.querySelectorAll(':scope > [data-structured-item]')];items.forEach((item,index)=>{item.querySelector(':scope > header .structured-config-index').textContent=String(index+1);const up=item.querySelector('[data-structured-move="up"]'),down=item.querySelector('[data-structured-move="down"]');if(up)up.disabled=index===0;if(down)down.disabled=index===items.length-1});return items.length}
  let itemCount=0
  if(category==='market_menu')itemCount=refreshItems(editor.querySelector(':scope > .structured-config-items'))
  else groups.forEach((group,index)=>{group.querySelector(':scope > .structured-config-group-head .structured-config-index').textContent=String(index+1);const up=group.querySelector('[data-structured-group-move="up"]'),down=group.querySelector('[data-structured-group-move="down"]');if(up)up.disabled=index===0;if(down)down.disabled=index===groups.length-1;itemCount+=refreshItems(group.querySelector(':scope > .structured-config-items'))})
  const count=editor.querySelector('[data-structured-count]');if(count)count.textContent=category==='market_menu'?`${itemCount} 个菜单项`:`${groups.length} 个分类 · ${itemCount} 个工具`
  syncStructuredConfig(editor)
}
function validateStructuredConfigEditor(editor){
  let firstInvalid=null
  editor.querySelectorAll('[required]').forEach(field=>{const invalid=!field.value.trim();field.setAttribute('aria-invalid',String(invalid));if(invalid&&!firstInvalid)firstInvalid=field})
  editor.dataset.structuredInvalid=String(Boolean(firstInvalid))
  return firstInvalid
}
function bindStructuredConfigEditor(editor){
  const changed=()=>{refreshStructuredConfigEditor(editor);validateStructuredConfigEditor(editor);setSystemConfigDirty(true)}
  editor.addEventListener('input',event=>{
    if(event.target.matches('[data-structured-field="name"]'))event.target.closest('[data-structured-item]')?.querySelector(':scope > header strong')?.replaceChildren(event.target.value.trim()||'新条目')
    if(event.target.matches('[data-structured-field="url"]'))event.target.closest('[data-structured-item]')?.querySelector(':scope > header small')?.replaceChildren(event.target.value.trim()||'尚未填写链接')
    changed()
  })
  editor.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return
    const item=button.closest('[data-structured-item]'),group=button.closest('[data-structured-group]')
    if(button.matches('[data-structured-add-group]'))editor.querySelector(':scope > .structured-config-groups').insertAdjacentHTML('beforeend',toolboxGroupHtml({},editor.querySelectorAll(':scope > .structured-config-groups > [data-structured-group]').length))
    else if(button.matches('[data-structured-add-item]')){const container=group?.querySelector(':scope > .structured-config-items')||editor.querySelector(':scope > .structured-config-items'),html=editor.dataset.structuredConfig==='market_menu'?marketMenuItemHtml({},container.children.length):toolboxItemHtml({},container.children.length);container.insertAdjacentHTML('beforeend',html)}
    else if(button.matches('[data-structured-remove]'))item?.remove()
    else if(button.matches('[data-structured-group-remove]'))group?.remove()
    else if(button.matches('[data-structured-move]')&&item){const direction=button.dataset.structuredMove,sibling=direction==='up'?item.previousElementSibling:item.nextElementSibling;if(sibling)item.parentElement.insertBefore(direction==='up'?item:sibling,direction==='up'?sibling:item)}
    else if(button.matches('[data-structured-group-move]')&&group){const direction=button.dataset.structuredGroupMove,sibling=direction==='up'?group.previousElementSibling:group.nextElementSibling;if(sibling)group.parentElement.insertBefore(direction==='up'?group:sibling,direction==='up'?sibling:group)}
    else return
    renderIcons(editor);changed()
  })
  refreshStructuredConfigEditor(editor)
}
function planPriceCycleHtml(plan,period,items){
  const currentKey=`${plan}_${period}`,originalKey=`${currentKey}_original`,current=items.find(item=>item.key===currentKey),original=items.find(item=>item.key===originalKey)
  if(!current&&!original)return ''
  const currentIndex=Math.max(0,items.indexOf(current)),originalIndex=Math.max(0,items.indexOf(original)),periodLabel=period==='month'?'月付':'年付'
  const field=(item,index,label,kind)=>item?`<label class="plan-price-field" for="${systemConfigControlId(item,index)}"><span>${label}</span><div class="plan-price-input"><b aria-hidden="true">$</b>${systemConfigInput(item,index,'plan_prices')}<small>USD</small></div><span class="config-field-error" id="${systemConfigControlId(item,index)}_error" role="alert" hidden></span><input type="hidden" data-config-label="${escapeHtml(item.key)}" value="${escapeHtml(configItemLabel(item))}"><input type="hidden" data-config-order="${escapeHtml(item.key)}" value="${Number(item.sort_order??index)}"><i>${kind==='current'?'用户实际支付金额':'仅用于主站划线价展示'}</i></label>`:''
  return `<section class="plan-price-cycle" data-plan-price-cycle="${currentKey}"><header><strong>${periodLabel}</strong><small>${period==='month'?'按月购买':'一次购买 12 个月'}</small></header>${field(current,currentIndex,'当前售价','current')}${field(original,originalIndex,'展示原价','original')}<div class="plan-price-calculation" data-plan-price-summary="${currentKey}" aria-live="polite"></div></section>`
}
function planPricesEditorHtml(items){
  const plan=(key,name,description)=>`<article class="plan-price-plan" data-plan-price="${key}"><header><span>${key==='plus'?'P+':'PRO'}</span><div><h3>${name}</h3><p>${description}</p></div><small data-plan-price-overview="${key}">读取价格…</small></header><div class="plan-price-cycles">${planPriceCycleHtml(key,'month',items)}${planPriceCycleHtml(key,'year',items)}</div></article>`
  return `<section class="plan-price-editor"><div class="plan-price-guidance"><span data-icon="info" aria-hidden="true"></span><div><strong>所有金额均为美元</strong><p>“当前售价”用于创建真实订单；“展示原价”只在主站显示划线价格，不参与扣款。</p></div></div><div class="plan-price-plans">${plan('plus','Plus 进阶版','适合需要持续分析与进阶功能的用户')}${plan('pro','Pro 专业版','适合需要完整专业能力与更高权限的用户')}</div></section>`
}
function refreshPlanPriceSummaries(root){
  root.querySelectorAll('[data-plan-price-cycle]').forEach(cycle=>{
    const key=cycle.dataset.planPriceCycle,current=Number(cycle.querySelector(`[data-config-key="${key}"]`)?.value||0),original=Number(cycle.querySelector(`[data-config-key="${key}_original"]`)?.value||0),period=key.endsWith('_year')?'year':'month',parts=[]
    if(current>0&&period==='year')parts.push(`折合 $${(current/12).toFixed(2)} / 月`)
    if(current>0&&original>current)parts.push(`比展示原价省 $${original-current}（${Math.round((1-current/original)*100)}%）`)
    else parts.push(original>0&&current>=original?'当前售价未低于展示原价':'未设置优惠对比')
    const summary=cycle.querySelector('[data-plan-price-summary]');if(summary)summary.innerHTML=`<strong>${escapeHtml(parts[0])}</strong>${parts[1]?`<small>${escapeHtml(parts[1])}</small>`:''}`
  })
  root.querySelectorAll('[data-plan-price]').forEach(plan=>{const key=plan.dataset.planPrice,month=Number(plan.querySelector(`[data-config-key="${key}_month"]`)?.value||0),year=Number(plan.querySelector(`[data-config-key="${key}_year"]`)?.value||0),overview=plan.querySelector('[data-plan-price-overview]');if(overview)overview.textContent=`月付 $${month||'--'} · 年付 $${year||'--'}`})
}
function defaultSystemConfigRowsHtml(category,items){
  return items.map((item,index)=>{const id=systemConfigControlId(item,index),label=configItemLabel(item),helper=systemConfigKeyHelp[item.key]||'保存后将应用到相关平台服务。',sensitive=item.config_meta?.sensitive||isSensitiveConfigKey(item.key),readonly=item.config_meta?.editable===false;return `<div class="config-editor-row ${readonly?'is-readonly':''} ${['market_menu','toolbox'].includes(category)&&item.key==='items'?'is-structured':''}"><div class="config-field-copy"><div><label ${readonly?'':`for="${id}"`}>${escapeHtml(label)}</label>${sensitive?'<span>敏感</span>':readonly?'<span>只读</span>':''}</div><p>${escapeHtml(helper)}</p></div><div class="config-field-control">${systemConfigInput(item,index,category)}<small class="config-field-error" id="${id}_error" role="alert" hidden></small></div><input type="hidden" data-config-label="${escapeHtml(item.key)}" value="${escapeHtml(label)}"><input type="hidden" data-config-order="${escapeHtml(item.key)}" value="${Number(item.sort_order??index)}"></div>`}).join('')||'<div class="empty-state">该分类暂无配置项</div>'
}
function mediaStorageTestSummary(){
  const test=state.systemConfigStorage?.qiniu?.test||{}, configured=Boolean(state.systemConfigStorage?.qiniu?.configured)
  const status=test.status==='succeeded'?'已通过':test.status==='failed'?'测试失败':test.status==='stale'?'配置已变更':'尚未测试'
  const stage=test.stage||'尚未开始', when=test.tested_at?`最近时间：${formatDate(test.tested_at,true)}`:'暂无测试时间'
  const note=state.systemConfigDirty?'当前分类有未保存修改，保存后需要重新测试。':!configured?'请先在“七牛连接”分类填写并保存凭证。':test.expired?'测试结果已过期，请重新测试。':test.error?'请根据失败阶段检查权限后重试。':'七牛凭证、临时对象上传、读取和删除均会在测试中验证。'
  return {status,stage,when,note, tone:test.status==='succeeded'&&!test.expired?'success':test.status==='failed'||test.status==='stale'?'warning':'muted'}
}
function mediaStorageOperationsHtml(){
  const operations=state.systemConfigStorage?.operations
  if(!operations)return '<div class="media-storage-operations-empty">存储运行数据暂不可用</div>'
  const totals=operations.totals||{},local=operations.local||{},groups=Array.isArray(operations.groups)?operations.groups:[],providers=['local','qiniu'].map(provider=>{const rows=groups.filter(item=>item.provider===provider),files=rows.reduce((sum,item)=>sum+Number(item.file_count||0),0),bytes=rows.reduce((sum,item)=>sum+Number(item.total_bytes||0),0);return `<span><small>${provider==='qiniu'?'七牛云':'本地存储'}</small><strong>${files} 个文件</strong><i>${formatContentFileSize(bytes)}</i></span>`}).join('')
  const disk=local.ok?`${formatContentFileSize(local.free_bytes)} 可用 / ${formatContentFileSize(local.total_bytes)}${local.low_space?' · 空间偏低':''}`:'本地存储目录不可用'
  return `<section class="media-storage-operations" aria-label="存储运行概览"><div>${providers}</div><div class="media-storage-anomalies"><span>上传中 <strong>${Number(totals.uploading||0)}</strong></span><span>失败 <strong>${Number(totals.failed||0)}</strong></span><span>待删除 <strong>${Number(totals.deleting||0)}</strong></span></div><p class="${local.low_space||!local.ok?'is-warning':''}">本地磁盘：${escapeHtml(disk)} · 检查于 ${escapeHtml(formatDate(operations.checked_at,true))}</p></section>`
}
function systemCategoryTools(category) {
  if(category==='smtp')return `<section class="config-action-panel"><div class="config-tool-heading"><span class="config-tool-icon" data-icon="mail" aria-hidden="true"></span><div><span class="eyebrow">连接验证</span><strong>发送测试邮件</strong><small>请先保存配置，再向指定邮箱发送测试邮件。</small></div></div><div class="config-action-form"><label class="field" for="smtpTestTarget"><span>收件邮箱</span><input class="input" id="smtpTestTarget" type="email" placeholder="name@example.com"></label><button class="secondary-button" id="smtpTestSend" type="button">发送测试</button></div></section>`
  if(category==='sms')return `<section class="config-action-panel"><div class="config-tool-heading"><span class="config-tool-icon" data-icon="phone" aria-hidden="true"></span><div><span class="eyebrow">连接验证</span><strong>发送测试短信</strong><small>验证码、到期提醒和已过期提醒使用不同模板。</small></div></div><div class="config-action-form sms-action-form"><label class="field" for="smsTestTarget"><span>测试手机号</span><input class="input" id="smsTestTarget" type="tel" placeholder="请输入手机号"></label><label class="field" for="smsTestTemplate"><span>短信模板</span><select class="select" id="smsTestTemplate"><option value="verification">验证码模板</option><option value="membership_expiry">会员到期提醒</option><option value="membership_expired">会员已过期提醒</option></select></label><button class="secondary-button" id="smsTestSend" type="button">发送测试</button></div></section>`
  if(category==='crypto_wallet')return `<section class="config-action-panel payment-capability-panel"><div class="config-tool-heading"><span class="config-tool-icon" data-icon="shield" aria-hidden="true"></span><div><span class="eyebrow">当前生产能力</span><strong>固定地址 TRC-20</strong><small>订单按收款地址、金额尾差和有效期自动匹配；动态派生地址、其他网络与后台资金归集尚未开放。</small></div></div><span class="badge active">执行合约已锁定</span></section>`
  if(category==='media_storage'){
    const summary=mediaStorageTestSummary()
    return `<section class="config-action-panel media-storage-action-panel"><div class="config-tool-heading"><span class="config-tool-icon" data-icon="cloud" aria-hidden="true"></span><div><span class="eyebrow">七牛连接测试</span><strong>配置版本闭环</strong><small>检查凭证、空间访问、临时对象上传、读取和删除；不会在数据库保存令牌或签名地址。</small></div></div><div class="media-storage-test-state tone-${summary.tone}"><strong>${summary.status}</strong><span>${escapeHtml(summary.stage)}</span><small>${escapeHtml(summary.when)}</small><p>${escapeHtml(summary.note)}</p></div>${mediaStorageOperationsHtml()}<div class="config-action-form"><button class="secondary-button" id="mediaStorageTest" type="button">测试当前连接</button><button class="text-button" id="mediaStorageOpenQiniu" type="button">维护七牛连接</button></div><p class="config-contract-note">存储切换只影响新文件，已有文件继续从原位置读取；云端失败不会静默改存本地。</p></section>`
  }
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
  }catch(error){root.innerHTML=`<div class="config-operation-error"><span data-icon="alert" aria-hidden="true"></span><div><strong>链上数据暂时不可用</strong><small>${escapeHtml(error.message||'请检查钱包配置或网络连接后重试。')}</small></div><button class="secondary-button" id="retryCryptoOperations" type="button">重新读取</button></div>`;renderIcons(root);root.querySelector('#retryCryptoOperations').onclick=()=>loadCryptoOperations()}
}
function bindSystemCategoryTools(category) {
  if(category==='smtp')document.querySelector('#smtpTestSend')?.addEventListener('click',async event=>{const target=document.querySelector('#smtpTestTarget').value.trim();if(!target)return handleError(new Error('请输入测试收件邮箱'));event.currentTarget.disabled=true;try{await api('/api/system-config/smtp/test',{method:'POST',body:JSON.stringify({to:target})});toast('测试邮件已发送','success')}catch(error){handleError(error)}finally{event.currentTarget.disabled=false}})
  if(category==='sms')document.querySelector('#smsTestSend')?.addEventListener('click',async event=>{const target=document.querySelector('#smsTestTarget').value.trim(),template=document.querySelector('#smsTestTemplate').value;if(!target)return handleError(new Error('请输入测试手机号'));if(!await confirmAction('发送测试短信？',`系统将立即向 ${target} 发送所选模板，可能产生短信费用。`,'确认发送'))return;event.currentTarget.disabled=true;try{await api('/api/system-config/sms/test',{method:'POST',body:JSON.stringify({to:target,template:template==='verification'?undefined:template})});toast('测试短信已发送','success')}catch(error){handleError(error)}finally{event.currentTarget.disabled=false}})
  if(category==='media_storage'){
    document.querySelector('#mediaStorageTest')?.addEventListener('click',async event=>{if(state.systemConfigDirty)return handleError(new Error('请先保存当前分类，再测试连接'));event.currentTarget.disabled=true;try{const result=await api('/api/system-config/media_storage/test',{method:'POST',body:JSON.stringify({})});toast(result.test?.status==='succeeded'?'七牛连接测试已通过':'七牛连接测试未通过',result.test?.status==='succeeded'?'success':'error');await loadSystemConfig()}catch(error){handleError(error);await loadSystemConfig().catch(()=>{})}finally{event.currentTarget.disabled=false}})
    document.querySelector('#mediaStorageOpenQiniu')?.addEventListener('click',async()=>{
      if(state.systemConfigDirty&&!await confirmAction('放弃尚未保存的修改？','切换到七牛连接会丢失当前页面中尚未保存的内容。','放弃修改',true))return
      state.systemConfigDirty=false;state.systemConfigCategory='qiniu';updateSystemConfigUrl('qiniu');renderSystemConfigNavigation();renderSystemConfigCategory()
    })
  }
}
function systemConfigStats(){
  const groups=state.systemConfig||{},categories=Object.keys(groups).filter(key=>key!=='changelog'),items=categories.flatMap(key=>groups[key]||[])
  return {categories:categories.length,items:items.length,configured:items.filter(item=>String(item.value??'').trim()).length,sensitive:items.filter(item=>item.value==='***REDACTED***').length}
}
function systemSettingsOverviewHtml(){
  if(!state.systemConfig)return '<div class="system-overview-skeleton"></div>'.repeat(4)
  const stats=systemConfigStats(),version=state.contentOverview?.release?.version||'--'
  return `<article><span>配置分类</span><strong>${stats.categories}</strong><small>平台服务模块</small></article><article><span>配置字段</span><strong>${stats.items}</strong><small>${stats.configured} 项已有内容</small></article><article class="is-secure"><span>敏感内容</span><strong>${stats.sensitive}</strong><small>已脱敏保护</small></article><article class="is-accent"><span>当前版本</span><strong>${escapeHtml(version)}</strong><small>主站与 AI 实验室</small></article>`
}
function refreshSystemSettingsOverview(){const root=document.querySelector('#systemSettingsOverview');if(root)root.innerHTML=systemSettingsOverviewHtml()}
function systemConfigAvailableCategories(){
  const available=Object.keys(state.systemConfig||{}).filter(key=>key!=='changelog')
  return [...available].sort((a,b)=>{const ai=systemCategoryOrder.indexOf(a),bi=systemCategoryOrder.indexOf(b);return (ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b)})
}
function systemConfigMatches(category,query){
  if(!query)return true
  const meta=systemCategoryMeta[category]||{},haystack=[meta.label,meta.description,category,...(state.systemConfig?.[category]||[]).flatMap(item=>[configItemLabel(item),item.key])].join(' ').toLowerCase()
  return haystack.includes(query.toLowerCase())
}
function updateSystemConfigUrl(category){const url=new URL(location.href);url.searchParams.set('view','system-settings');if(category)url.searchParams.set('section',category);history.replaceState({},'',`${url.pathname}${url.search}`)}
function renderSystemConfigNavigation(){
  const nav=document.querySelector('#systemConfigCategoryList');if(!nav)return
  const available=systemConfigAvailableCategories(),query=state.systemConfigSearch.trim(),filtered=available.filter(key=>systemConfigMatches(key,query))
  nav.innerHTML=filtered.map(key=>{const meta=systemCategoryMeta[key]||{label:key,description:'平台配置',icon:'settings',tone:'standard',toneLabel:'配置'};const active=key===state.systemConfigCategory;return `<button class="config-nav-item ${active?'is-active':''}" data-system-category="${escapeHtml(key)}" type="button" role="tab" aria-selected="${active}"><span class="config-nav-icon" data-icon="${meta.icon}" aria-hidden="true"></span><span class="config-nav-copy"><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.description)}</small></span><span class="config-nav-meta"><b>${state.systemConfig[key].length}</b><i class="tone-${meta.tone}">${escapeHtml(meta.toneLabel)}</i></span></button>`}).join('')||'<div class="config-nav-empty"><strong>没有匹配的配置</strong><small>尝试搜索“短信”“价格”或“钱包”。</small></div>'
  const result=document.querySelector('#systemConfigSearchResult');if(result)result.textContent=query?`${filtered.length} 个匹配分类`:`共 ${available.length} 个分类`
  renderIcons(nav)
  nav.querySelectorAll('[data-system-category]').forEach(button=>button.onclick=async()=>{
    if(button.dataset.systemCategory===state.systemConfigCategory)return
    if(state.systemConfigDirty&&!await confirmAction('放弃尚未保存的修改？','切换分类会丢失当前页面中尚未保存的内容。','放弃修改',true))return
    state.systemConfigDirty=false;state.systemConfigCategory=button.dataset.systemCategory;updateSystemConfigUrl(state.systemConfigCategory);renderSystemConfigNavigation();renderSystemConfigCategory()
  })
}
function setSystemConfigDirty(dirty){
  state.systemConfigDirty=Boolean(dirty)
  const status=document.querySelector('#systemConfigSaveState'),save=document.querySelector('#saveSystemConfig'),discard=document.querySelector('#discardSystemConfig')
  const hasErrors=Boolean(document.querySelector('#systemConfigEditor [aria-invalid="true"]'))
  if(status){status.classList.toggle('is-dirty',state.systemConfigDirty&&!hasErrors);status.classList.toggle('is-error',hasErrors);status.innerHTML=hasErrors?'<span></span><strong>配置内容需要修正</strong><small>请检查标记出的字段</small>':state.systemConfigDirty?'<span></span><strong>有未保存的修改</strong><small>保存后立即应用</small>':'<span></span><strong>当前分类已同步</strong><small>修改任意字段后可保存</small>'}
  if(save)save.disabled=!state.systemConfigDirty||hasErrors
  if(discard)discard.disabled=!state.systemConfigDirty
}
function validateSystemConfigControl(control){
  const row=control.closest('.plan-price-field')||control.closest('[data-plan-price-cycle]')||control.closest('.config-editor-row'),error=row?.querySelector('.config-field-error');let message=''
  const value=control.dataset.configBoolean==='true'?String(control.checked):String(control.value||'').trim()
  const structuredEditor=control.closest('[data-structured-config]'),structuredInvalid=structuredEditor?validateStructuredConfigEditor(structuredEditor):null
  if(structuredInvalid)message='请填写所有标记为必填的名称和访问地址。'
  if(!message&&control.required&&!value)message='该价格不能为空。'
  if(value&&(['items'].includes(control.dataset.configKey)||value.startsWith('[')||value.startsWith('{'))){try{JSON.parse(value)}catch{message='JSON 格式不正确，请检查括号、引号和逗号。'}}
  if(!message&&control.type==='number'&&value&&!/^-?\d+$/.test(value))message='请输入整数。'
  if(!message&&control.type==='number'&&value&&control.hasAttribute('min')&&Number(value)<Number(control.min))message=`数值不能小于 ${control.min}。`
  if(!message&&control.type==='number'&&value&&control.hasAttribute('max')&&Number(value)>Number(control.max))message=`数值不能大于 ${control.max}。`
  if(!message&&value&&['email','url'].includes(control.type)&&!control.checkValidity())message=control.type==='email'?'请输入有效的邮箱地址。':'请输入完整有效的地址。'
  control.setAttribute('aria-invalid',String(Boolean(message)&&!structuredEditor));row?.classList.toggle('has-error',Boolean(message));if(error){error.hidden=!message;error.textContent=message}
  return !message
}
function renderSystemConfigCategory(){
  const root=document.querySelector('#systemConfigEditor');if(!root||!state.systemConfig)return
  const category=state.systemConfigCategory,items=state.systemConfig[category]||[],meta=systemCategoryMeta[category]||{label:category,description:'平台配置',icon:'settings',tone:'standard',toneLabel:'配置'}
  const sensitiveCount=items.filter(item=>item.config_meta?.sensitive||isSensitiveConfigKey(item.key)).length,encryptionReady=state.systemConfigSecurity?.credential_encryption_available!==false
  root.innerHTML=`<header class="system-config-head"><div class="system-config-heading"><span class="system-config-mark tone-${meta.tone}" data-icon="${meta.icon}" aria-hidden="true"></span><div><span class="eyebrow">平台配置</span><h2>${escapeHtml(meta.label)}</h2><p>${escapeHtml(meta.description)}</p></div></div><div class="system-config-badges"><span>${items.length} 项配置</span><span class="tone-${meta.tone}">${escapeHtml(meta.toneLabel)}</span>${sensitiveCount?`<span>${sensitiveCount} 项敏感</span>`:''}</div></header>${sensitiveCount?`<div class="system-secret-notice ${encryptionReady?'':'is-warning'}"><span data-icon="shield" aria-hidden="true"></span><p><strong>${encryptionReady?'敏感内容已加密保护':'凭证加密服务未就绪'}</strong><small>${encryptionReady?'密钥和密码使用 AES-256-GCM 保存且不会回显；留空即可保持原值。':'为避免明文落库，敏感字段暂时禁止修改。'}</small></p></div>`:''}<form class="config-editor-form" id="systemConfigForm">${category==='plan_prices'?planPricesEditorHtml(items):defaultSystemConfigRowsHtml(category,items)}<footer class="system-config-savebar"><div class="system-config-save-state" id="systemConfigSaveState" aria-live="polite"></div><div><button class="secondary-button" id="discardSystemConfig" type="button" disabled><span data-icon="rotate"></span>放弃修改</button><button class="primary-button" id="saveSystemConfig" type="submit" disabled><span data-icon="save"></span>保存当前分类</button></div></footer></form>${systemCategoryTools(category)}`
  renderIcons(root);setSystemConfigDirty(false)
  const controls=[...root.querySelectorAll('[data-config-key]')]
  controls.forEach(control=>{const markDirty=()=>{if(control.dataset.configBoolean==='true'){const label=root.querySelector(`label[for="${CSS.escape(control.id)}"] [data-config-toggle-label]`);if(label)label.textContent=control.checked?'已开启':'已关闭'}validateSystemConfigControl(control);if(category==='plan_prices')refreshPlanPriceSummaries(root);if(category==='media_storage'&&control.dataset.storageProvider)refreshStorageEffectiveProviders(root);setSystemConfigDirty(true)};control.addEventListener('input',markDirty);control.addEventListener('change',markDirty);control.addEventListener('blur',()=>validateSystemConfigControl(control))})
  root.querySelectorAll('[data-structured-config]').forEach(bindStructuredConfigEditor)
  if(category==='plan_prices')refreshPlanPriceSummaries(root)
  root.querySelector('#discardSystemConfig').onclick=async()=>{if(!state.systemConfigDirty)return;if(!await confirmAction('放弃当前修改？','当前分类中尚未保存的内容将恢复为服务器最新值。','放弃修改',true))return;renderSystemConfigCategory()}
  root.querySelector('#systemConfigForm').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;if(!state.systemConfigDirty)return
    const valid=controls.map(validateSystemConfigControl).every(Boolean);if(!valid){root.querySelector('[aria-invalid="true"]:not(.structured-config-value)')?.focus();return handleError(new Error('请先修正标记出的配置内容'))}
    if(meta.tone==='critical'&&!await confirmAction('确认保存高风险配置？','收款钱包配置会影响订单收款和链上资金处理，请确认地址、网络与密钥均正确。','确认保存',true))return
    button.disabled=true
    try{
      const payload=controls.map((control,index)=>{const key=control.dataset.configKey;let value=control.dataset.configBoolean==='true'?String(control.checked):control.value;if(control.dataset.redacted==='true'&&!value)value='***REDACTED***';return{key,value,label:root.querySelector(`[data-config-label="${CSS.escape(key)}"]`)?.value||'',sort_order:Number(root.querySelector(`[data-config-order="${CSS.escape(key)}"]`)?.value||index)}})
      await api(`/api/system-config/${encodeURIComponent(category)}`,{method:'PUT',body:JSON.stringify({items:payload})});toast(`${meta.label}已保存`,'success');state.systemConfigDirty=false;await loadSystemConfig()
    }catch(error){handleError(error);button.disabled=false}
  }
  bindSystemCategoryTools(category)
}
async function loadSystemConfig(){
  const data=await api('/api/system-config');state.systemConfig=data.config||{};state.systemConfigSecurity=data.security||{};state.systemConfigStorage=data.storage||null
  const available=systemConfigAvailableCategories(),requested=new URLSearchParams(location.search).get('section')
  if(requested&&available.includes(requested))state.systemConfigCategory=requested
  if(!available.includes(state.systemConfigCategory))state.systemConfigCategory=available[0]||''
  state.systemConfigDirty=false;renderSystemConfigNavigation();renderSystemConfigCategory();refreshSystemSettingsOverview()
}
function updateReleaseNotesImpact(root){
  const version=Number(root.querySelector('#releaseVersion')?.value||0),current=Number(state.releaseNotesVersion||0),target=root.querySelector('#releaseNotificationImpact')
  if(!target)return
  if(version>current)target.textContent='本次保存将提高通知序号，用户会再次看到这条更新。'
  else if(version===current&&current>0)target.textContent='本次仅修正文案，不会重新通知已读用户。'
  else target.textContent='通知序号必须不小于当前序号。'
}
function applyReleaseNotesPreview(root,result){
  const preview=root.querySelector('#releasePreview'),removed=root.querySelector('#releasePreviewRemoved')
  if(preview){preview.innerHTML=result?.content||'<p class="release-preview-empty">暂无可预览内容</p>'}
  if(removed){const categories=Array.isArray(result?.removed_categories)?result.removed_categories:[];removed.textContent=categories.length?`已移除：${categories.join('、')}`:'未发现需要移除的内容';removed.dataset.state=categories.length?'changed':'clean'}
}
function scheduleReleaseNotesPreview(root){
  const content=root.querySelector('#releaseContent')?.value||''
  clearTimeout(state.releaseNotesPreviewTimer)
  state.releaseNotesPreviewTimer=setTimeout(async()=>{try{const result=await api('/api/admin/release-notes/preview',{method:'POST',body:JSON.stringify({content})});if(root.isConnected)applyReleaseNotesPreview(root,result)}catch(error){if(root.isConnected){const removed=root.querySelector('#releasePreviewRemoved');if(removed)removed.textContent=error.message||'预览暂时不可用'}}},240)
}
async function loadReleaseNotesEditor(root){
  try{
    const result=await api('/api/admin/release-notes');if(!root.isConnected)return
    state.releaseNotesRevision=String(result.revision||'');state.releaseNotesVersion=Number(result.version||1)
    const version=root.querySelector('#releaseVersion'),content=root.querySelector('#releaseContent')
    if(version)version.value=String(result.version||1)
    if(content){content.value=String(result.content||'');root.querySelector('#releaseContentCount').textContent=content.value.length}
    if(result.revision)applyReleaseNotesPreview(root,result)
    else applyReleaseNotesPreview(root,{content:`<p>${escapeHtml(String(result.content||''))}</p>`,removed_categories:['legacy_response_not_sanitized']})
    updateReleaseNotesImpact(root)
  }catch(error){const marker=root.querySelector('#releasePreviewRemoved');if(marker)marker.textContent=error.message||'读取发布说明失败'}
}
function renderContentSystem(){
  const o=state.contentOverview||{},release=o.release||{},root=document.querySelector('#contentSystemBody')
  root.innerHTML=`<section class="system-workbench"><section class="system-overview-strip" id="systemSettingsOverview" aria-label="系统配置概览">${systemSettingsOverviewHtml()}</section><article class="panel system-release-panel"><div class="system-release-intro"><span class="system-release-icon" data-icon="file" aria-hidden="true"></span><div><span class="eyebrow">版本发布</span><h2>发布说明</h2><p>主站与 AI 实验室共用当前版本说明，保存后立即对用户可见。</p><small class="release-contract-note">通知序号 1～2147483647；软件版本请写在内容标题中。</small></div><time>${release.updated_at?`最近更新 ${formatDate(release.updated_at,true)}`:'尚未记录更新时间'}</time></div><form class="system-release-form" id="releaseForm"><label class="field release-version-field" for="releaseVersion"><span>通知序号</span><input class="input" id="releaseVersion" required inputmode="numeric" pattern="[0-9]+" min="1" max="2147483647" value="${escapeHtml(release.version||'')}"><small class="field-help">相同序号修正文案不会重新通知；递增才会通知。</small></label><label class="field release-content-field" for="releaseContent"><span>更新内容（安全 HTML）</span><textarea class="input release-textarea" id="releaseContent" required maxlength="50000">${escapeHtml(release.content||'')}</textarea><small class="release-content-count"><b id="releaseContentCount">${String(release.content||'').length}</b> / 50000 个字符</small></label><button class="primary-button" type="submit"><span data-icon="save"></span>保存发布说明</button><div class="release-notification-impact" id="releaseNotificationImpact" aria-live="polite"></div></form><section class="release-preview-panel" aria-label="安全预览"><header><strong>安全预览</strong><span>由服务端白名单净化后展示</span></header><div class="release-preview" id="releasePreview"><p class="release-preview-empty">正在读取预览…</p></div><p class="release-preview-removed" id="releasePreviewRemoved" aria-live="polite">正在检查被移除内容…</p><p class="release-supported-tags">支持标题、段落、列表、强调、链接和代码；脚本、表单、事件属性及危险样式会被移除。</p></section></article><section class="settings-workbench"><aside class="panel system-config-sidebar"><header><div><span class="eyebrow">配置目录</span><h2>平台服务</h2></div><span id="systemConfigSearchResult">读取中</span></header><label class="system-config-search" for="systemConfigSearch"><span data-icon="search" aria-hidden="true"></span><input class="input" id="systemConfigSearch" value="${escapeHtml(state.systemConfigSearch)}" placeholder="搜索分类或配置项"><small>/</small></label><nav class="config-nav" id="systemConfigCategoryList" role="tablist" aria-label="系统配置分类"><div class="empty-inline">正在读取配置分类…</div></nav></aside><article class="panel system-config-editor" id="systemConfigEditor" role="tabpanel"><div class="empty-state">正在读取系统配置…</div></article></section></section>`
  renderIcons(root)
  const search=root.querySelector('#systemConfigSearch');search.oninput=()=>{state.systemConfigSearch=search.value.trim();renderSystemConfigNavigation()};search.onkeydown=event=>{if(event.key==='Escape'){search.value='';state.systemConfigSearch='';renderSystemConfigNavigation()}}
  const versionInput=root.querySelector('#releaseVersion'),contentInput=root.querySelector('#releaseContent')
  versionInput.oninput=()=>updateReleaseNotesImpact(root)
  contentInput.oninput=event=>{root.querySelector('#releaseContentCount').textContent=event.currentTarget.value.length;scheduleReleaseNotesPreview(root)}
  root.querySelector('#releaseForm').onsubmit=async event=>{event.preventDefault();const button=event.submitter,version=versionInput.value,content=contentInput.value;if(!/^[0-9]+$/.test(version)||Number(version)<1||Number(version)>2147483647)return handleError(new Error('通知序号必须是 1 到 2147483647 的整数'));if(content.length>50000)return handleError(new Error('更新内容不能超过 50000 个字符'));button.disabled=true;try{const body={version,content,expected_revision:state.releaseNotesRevision||undefined};const result=await api('/api/admin/release-notes',{method:'POST',body:JSON.stringify(body)});state.releaseNotesRevision=String(result.revision||'');state.releaseNotesVersion=Number(result.version||version);state.contentOverview={...(state.contentOverview||{}),release:{...((state.contentOverview||{}).release||{}),version:result.version,content:result.content}};versionInput.value=String(result.version);contentInput.value=String(result.content||'');root.querySelector('#releaseContentCount').textContent=contentInput.value.length;applyReleaseNotesPreview(root,result);updateReleaseNotesImpact(root);toast('发布说明已保存','success')}catch(error){handleError(error)}finally{button.disabled=false}}
  loadReleaseNotesEditor(root).catch(handleError)
  loadSystemConfig().catch(handleError)
}
function contentOverviewStrip(){
  const summary=state.contentOverview?.summary
  if(!summary)return '<div class="content-overview-skeleton"></div>'.repeat(4)
  const cards=[
    ['book','课程总数',Number(summary.courses_total||0),'平台全部课程',''],
    ['check','已发布',Number(summary.courses_published||0),'主站当前可见','is-positive'],
    ['file','待完善草稿',Number(summary.courses_draft||0),'发布前继续编辑',''],
    ['paperclip','下载附件',Number(summary.attachments_total||0),'随课程权限开放','is-accent'],
  ]
  return cards.map(([icon,label,value,note,tone])=>`<article class="content-overview-card ${tone}"><span class="content-overview-icon" data-icon="${icon}" aria-hidden="true"></span><div><span>${label}</span><strong>${value.toLocaleString('zh-CN')}</strong><small>${note}</small></div></article>`).join('')
}
function contentHealthPanel(){
  const health=state.contentOverview?.content_health
  if(!health)return '<div class="content-overview-skeleton"></div>'
  const total=Number(health.published_total||0),complete=Number(health.complete_count||0),percent=health.completeness_percent==null?null:Number(health.completeness_percent)
  const issues=[['缺课程说明',health.missing_description],['缺视频来源',health.missing_video],['缺附件',health.missing_attachment],['缺测验',health.missing_quiz],['缺可视化资料',health.missing_visual],['30 天未更新',health.stale_30d]]
  return `<section class="content-health-panel panel" aria-label="已发布课程完整度"><div class="content-health-score"><span>已发布课程完整度</span><strong>${percent==null?'--':`${percent.toFixed(1)}%`}</strong><small>${complete} / ${total} 门课程达到完整标准</small><div><i style="width:${percent==null?0:Math.max(0,Math.min(100,percent))}%"></i></div></div><div class="content-health-issues">${issues.map(([label,value])=>`<span class="${Number(value)>0?'has-issue':''}"><b>${Number(value||0)}</b>${label}</span>`).join('')}</div><p>${Number(health.incomplete_with_learning||0)>0?`优先处理 ${Number(health.incomplete_with_learning)} 门已有学习记录但仍不完整的课程。`:'暂无已有学习记录的不完整课程。'}${health.feedback_workflow_available?'':' 反馈数据库暂无处理状态字段，本页不伪造待办闭环。'}</p></section>`
}
function refreshContentOverviewChrome(){const strip=document.querySelector('#contentOverviewStrip');if(strip){strip.innerHTML=contentOverviewStrip();renderIcons(strip)}const health=document.querySelector('#contentHealthPanel');if(health)health.innerHTML=contentHealthPanel();const release=document.querySelector('#contentReleaseVersion');if(release)release.textContent=state.contentOverview?.release?.version||'未设置'}
async function loadContentOverview(){const data=await api('/api/admin/content-system/overview');state.contentOverview=data.overview;refreshContentOverviewChrome();if(state.contentTab==='system')renderContentSystem()}
let qiniuVideoVendorPromise=null
let activeVideoUploadCancel=null
function loadQiniuVideoVendor(){
  if(window.qiniu?.upload)return Promise.resolve(window.qiniu)
  if(qiniuVideoVendorPromise)return qiniuVideoVendorPromise
  qiniuVideoVendorPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/qiniu-js-3.4.4.min.js';script.async=true;script.onload=()=>window.qiniu?.upload?resolve(window.qiniu):reject(new Error('七牛上传组件加载失败'));script.onerror=()=>reject(new Error('七牛上传组件加载失败'));document.head.appendChild(script)})
  return qiniuVideoVendorPromise
}
function uploadCourseVideoLocalManaged(file,episodeId,accessLevel,onProgress,onStatus){
  return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest(),form=new FormData();form.append('file',file);form.append('episodeId',String(episodeId));form.append('accessLevel',accessLevel||'plus_pro');form.append('title',file.name);xhr.open('POST','/api/video-upload');xhr.setRequestHeader('X-Video-Episode',String(episodeId));if(token())xhr.setRequestHeader('Authorization',`Bearer ${token()}`);activeVideoUploadCancel=()=>xhr.abort();xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100))};xhr.onerror=()=>reject(new Error('视频上传网络中断'));xhr.onabort=()=>reject(new Error('视频上传已取消'));xhr.onload=()=>{let result={};try{result=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300&&result.ok!==false){onStatus?.('正在校验视频');resolve(result)}else reject(new Error(result.error||'视频上传失败'))};xhr.send(form)})
}
async function uploadCourseVideoQiniuManaged(file,episodeId,accessLevel,onProgress,onStatus){
  const qiniu=await loadQiniuVideoVendor(),sessionKey=`ws_video_upload_session:${episodeId}:${file.name}:${file.size}:${file.lastModified}`
  let session=null
  try{const saved=sessionStorage.getItem(sessionKey);if(saved)session=await api(`/api/video-upload-session/${encodeURIComponent(saved)}`)}catch{}
  if(!session)session=await api('/api/video-upload-session',{method:'POST',body:JSON.stringify({episodeId,originalName:file.name,mimeType:'video/mp4',sizeBytes:file.size})})
  try{sessionStorage.setItem(sessionKey,session.sessionId)}catch{}
  const region=session.region&&qiniu.region?.[session.region]?qiniu.region[session.region]:undefined
  const observable=qiniu.upload(file,session.objectKey,session.token,{fname:file.name,mimeType:'video/mp4'},{chunkSize:8,forceDirect:false,useCdnDomain:false,region})
  await new Promise((resolve,reject)=>{let settled=false;const finish=callback=>value=>{if(settled)return;settled=true;callback(value)};const subscription=observable.subscribe({next:info=>onProgress(Math.max(0,Math.min(99,Math.round(Number(info?.total?.percent??info?.percent??0))))),error:finish(error=>reject(new Error(error?.message||'七牛上传失败'))),complete:finish(resolve)});activeVideoUploadCancel=()=>{if(settled)return;subscription.unsubscribe();settled=true;reject(new Error('视频上传已取消'))}})
  onProgress(100);onStatus?.('正在校验视频')
  const result=await api('/api/video-upload-confirm',{method:'POST',body:JSON.stringify({sessionId:session.sessionId,episodeId,accessLevel,title:file.name})});try{sessionStorage.removeItem(sessionKey)}catch{};return result
}
async function uploadCourseVideoManaged(file,episodeId,accessLevel,onProgress,onStatus){
  const target=await api('/api/video-storage-provider')
  if(target.provider==='qiniu')return uploadCourseVideoQiniuManaged(file,episodeId,accessLevel,onProgress,onStatus)
  return uploadCourseVideoLocalManaged(file,episodeId,accessLevel,onProgress,onStatus)
}
function bindManagedVideoUpload(root){
  const form=root?.querySelector('#courseVideoUpload');if(!form)return
  const input=form.querySelector('#videoFile'),submit=form.querySelector('button[type="submit"]'),progress=form.querySelector('#videoUploadProgress'),bar=progress?.querySelector('progress'),percent=form.querySelector('#videoUploadPercent'),status=form.querySelector('#videoUploadStatus')
  if(input)input.accept='.mp4,video/mp4'
  const dropHelp=input?.closest('.video-drop-field')?.querySelector('small');if(dropHelp)dropHelp.textContent='仅支持 MP4 / H.264 + AAC / 1920×1080；原文件直传，不转码。单文件上限 2GB。'
  if(status)status.setAttribute('aria-live','polite')
  if(progress)progress.setAttribute('aria-live','polite')
  const cancel=form.querySelector('[data-video-upload-cancel]'),targetNote=form.querySelector('#videoProviderTarget')
  if(targetNote)targetNote.setAttribute('aria-live','polite')
  api('/api/video-storage-provider').then(result=>{if(targetNote)targetNote.textContent=`实际存储位置：${result.provider==='qiniu'?'七牛云':'本地存储'}（由系统设置决定）`}).catch(()=>{if(targetNote)targetNote.textContent='实际存储位置暂不可用'})
  form.onsubmit=async event=>{event.preventDefault();const file=input?.files?.[0],courseId=Number(form.querySelector('#videoCourse')?.value),accessLevel=form.querySelector('#videoAccess')?.value||'plus_pro';if(!courseId||!file)return handleError(new Error('请选择课程和视频文件'));if(file.type!=='video/mp4'||!/\.mp4$/i.test(file.name))return handleError(new Error('仅支持 MP4（H.264 + AAC，1920×1080）'));if(submit)submit.disabled=true;if(cancel)cancel.hidden=false;if(progress)progress.hidden=false;if(status)status.textContent='正在准备视频上传';const cancelHandler=()=>activeVideoUploadCancel?.();cancel.onclick=cancelHandler;try{const uploaded=await uploadCourseVideoManaged(file,courseId,accessLevel,value=>{if(bar)bar.value=value;if(percent)percent.textContent=`${value}%`;if(status)status.textContent=value>=100?'正在校验视频':'正在上传视频'},value=>{if(status)status.textContent=value});if(!uploaded?.publishable)throw new Error('视频尚未通过服务端校验');if(status)status.textContent='校验完成，可发布';toast('视频已上传并关联课程','success');await renderContentVideos()}catch(error){handleError(error);if(status)status.textContent=error.message||'上传失败'}finally{activeVideoUploadCancel=null;if(cancel)cancel.hidden=true;if(submit)submit.disabled=false}}
}
async function renderContentVideos(){
  const data=await api('/api/admin/content-system/videos'),courses=data.courses||[],hosted=courses.filter(course=>course.has_stream_video||course.local_path||course.local_video_path||course.bilibili_id||course.youtube_id)
  const root=document.querySelector('#contentSystemBody')
  root.innerHTML=`<section class="video-admin-grid">
    <article class="panel content-video-upload-panel">
      <header class="section-head"><div><span class="eyebrow">统一托管</span><h2>上传课程视频</h2><p>按系统设置使用本地或七牛存储，校验通过后自动关联课程。</p></div><span class="content-panel-icon" data-icon="upload" aria-hidden="true"></span></header>
      <form class="video-upload-form" id="courseVideoUpload">
        <div class="video-upload-fields"><label class="field"><span>关联课程</span><select class="select" id="videoCourse" required><option value="">请选择课程</option>${courses.map(course=>`<option value="${course.id}">${String(course.number||course.id).padStart(2,'0')} · ${escapeHtml(course.title)}</option>`).join('')}</select></label><label class="field"><span>播放权限</span><select class="select" id="videoAccess"><option value="free">公开免费</option><option value="logged_in">登录可看</option><option value="plus_pro" selected>Plus / Pro</option><option value="pro_only">仅 Pro</option></select></label></div>
        <label class="video-drop-field"><input id="videoFile" type="file" accept=".mp4,video/mp4" required><span class="file-drop-icon" data-icon="video" aria-hidden="true"></span><span class="video-drop-copy"><strong>选择视频文件</strong><small>仅支持 MP4 / H.264 + AAC / 1920×1080；原文件直传，不转码。单文件上限 2GB。</small><small class="video-provider-target" id="videoProviderTarget" aria-live="polite">正在读取实际存储位置…</small></span></label>
        <div class="upload-progress" id="videoUploadProgress" hidden><div><span id="videoUploadStatus" aria-live="polite">准备上传</span><strong id="videoUploadPercent">0%</strong></div><progress max="100" value="0"></progress></div>
        <button class="primary-button" type="submit"><span data-icon="upload" aria-hidden="true"></span>上传并关联课程</button>
        <button class="secondary-button" type="button" data-video-upload-cancel hidden>取消上传</button>
      </form>
    </article>
    <article class="panel content-video-library">
      <header class="section-head"><div><span class="eyebrow">播放来源</span><h2>已配置视频</h2><p>本地、七牛与历史外部视频来源统一查看。</p></div><span class="content-panel-count"><strong>${hosted.length}</strong>门课程</span></header>
      <div class="hosted-video-list">${hosted.map(course=>{
        const source=course.video_source_label||(course.video_source==='local_mp4'?'本地 MP4':course.video_source==='qiniu_mp4'?'七牛 MP4':course.local_path||course.local_video_path?'本地托管':course.bilibili_id?'Bilibili':course.youtube_id?'YouTube':'历史外部视频')
        return `<article class="hosted-video-row" data-video-course="${course.id}"><span class="hosted-video-source" data-icon="video" aria-hidden="true"></span><div><strong>${escapeHtml(course.title)}</strong><small>${escapeHtml(source)} · ${escapeHtml(course.duration||'时长未识别')}</small></div><label><span>播放权限</span><select class="select" data-video-access aria-label="${escapeHtml(course.title)}的播放权限">${Object.entries(accessLabels).map(([value,label])=>`<option value="${value}" ${course.access_level===value?'selected':''}>${label}</option>`).join('')}</select></label>${course.video_source==='local_mp4'||course.video_source==='qiniu_mp4'||course.local_path||course.local_video_path?'<button class="text-button danger-text" data-video-unlink type="button">解除托管</button>':'<span class="badge">课程编辑中管理</span>'}</article>`
      }).join('')||'<div class="empty-state content-empty-state"><span class="content-empty-icon" data-icon="video" aria-hidden="true"></span><div><strong>暂无已配置的视频课程</strong><p>先在左侧选择课程并上传视频。</p></div></div>'}</div>
    </article>
  </section>`
  renderIcons(root)
  bindManagedVideoUpload(root)
  root.querySelectorAll('[data-video-access]').forEach(select=>select.onchange=async()=>{select.disabled=true;try{await api(`/api/video-stream?episode=${select.closest('[data-video-course]').dataset.videoCourse}`,{method:'PATCH',body:JSON.stringify({accessLevel:select.value})});toast('视频权限已更新','success')}catch(error){handleError(error);await renderContentVideos()}finally{select.disabled=false}})
  root.querySelectorAll('[data-video-unlink]').forEach(button=>button.onclick=async()=>{const row=button.closest('[data-video-course]');if(!await confirmAction('解除视频托管？','托管文件和课程关联会被删除，无法恢复；课程本身与学习记录不受影响。','确认解除',true))return;button.disabled=true;try{await api(`/api/video-stream?episode=${row.dataset.videoCourse}`,{method:'DELETE'});toast('视频托管已解除','success');await renderContentVideos()}catch(error){handleError(error);button.disabled=false}})
}
async function renderContentEngagement(){
  const data=await api('/api/admin/content-system/engagement'),summary=data.summary||{},rows=data.leaderboard||[]
  const root=document.querySelector('#contentSystemBody')
  const metrics=[
    ['check','完成课程',summary.lessons_completed,'全部用户累计','is-primary'],
    ['users','活跃学员',summary.learners_active,'至少完成一节课程',''],
    ['activity','通过测验',summary.quizzes_passed,'累计通过次数',''],
    ['message','社区互动',Number(summary.posts_total||0)+Number(summary.comments_total||0)+Number(summary.replies_total||0),`帖子 ${Number(summary.posts_total||0)} · 评论 ${Number(summary.comments_total||0)} · 回复 ${Number(summary.replies_total||0)}`,''],
  ]
  root.innerHTML=`<section class="content-learning-summary" aria-label="学习数据概览">${metrics.map(([icon,label,value,note,tone])=>`<article class="${tone}"><span class="content-overview-icon" data-icon="${icon}" aria-hidden="true"></span><div><span>${label}</span><strong>${Number(value||0).toLocaleString('zh-CN')}</strong><small>${note}</small></div></article>`).join('')}</section>
  <section class="panel content-leaderboard-panel"><header class="section-head"><div><span class="eyebrow">学习表现</span><h2>课程完成排行榜</h2><p>用于识别核心学员和课程使用深度，不作为会员权益依据。</p></div><span class="content-panel-count"><strong>${rows.length}</strong>名学员</span></header><div class="leaderboard-columns" aria-hidden="true"><span>排名与学员</span><span>完成课程</span><span>通过测验</span><span>开始学习</span></div><div class="leaderboard-list">${rows.map((row,index)=>`<button class="leaderboard-row" data-user-id="${Number(row.id)}" type="button" aria-label="查看学员：${escapeHtml(row.nickname||row.email||`用户 #${row.id}`)}"><span class="leaderboard-rank">${index+1}</span><div><strong>${escapeHtml(row.nickname||row.email||`用户 #${row.id}`)}</strong><small>${escapeHtml(row.uid||'未设置 UID')} · ${row.plan==='pro'?'Pro 专业版':row.plan==='plus'?'Plus 会员':'免费用户'}</small></div><div><span>完成课程</span><strong>${Number(row.lessons_completed||0)}</strong></div><div><span>通过测验</span><strong>${Number(row.quizzes_passed||0)}</strong></div><div><span>开始学习</span><strong>${Number(row.lessons_started||0)}</strong></div><span class="leaderboard-open" data-icon="chevron" aria-hidden="true"></span></button>`).join('')||'<div class="empty-state content-empty-state"><span class="content-empty-icon" data-icon="analytics" aria-hidden="true"></span><div><strong>暂无课程完成记录</strong><p>用户开始学习后，这里会展示完成度与测验表现。</p></div></div>'}</div></section>`
  renderIcons(root)
  bindUserOpeners(root)
}
async function renderContentTab(){if(state.contentTab==='assets')await loadCourseAssets();else if(state.contentTab==='video')await renderContentVideos();else if(state.contentTab==='engagement')await renderContentEngagement();else if(state.contentTab==='feedback')await renderContentFeedback();else if(state.contentTab==='system'){if(!state.contentOverview)await loadContentOverview();else renderContentSystem()}else await renderContentCourses()}
async function renderContentOperationsPage(){
  const main=document.querySelector('#adminMain')
  if(state.contentTab==='system')state.contentTab='courses'
  main.innerHTML=`<header class="page-head content-operations-head">
    <div class="content-title-lockup"><span class="content-title-icon" data-icon="archive" aria-hidden="true"></span><div><span class="eyebrow">内容交付中枢</span><h1>内容运营</h1><p>统一管理课程发布、下载课件、视频来源、学习表现与用户反馈。</p></div></div>
    <div class="content-head-actions"><div class="content-release-state"><span>主站内容版本</span><strong id="contentReleaseVersion">${escapeHtml(state.contentOverview?.release?.version||'读取中')}</strong><small>发布内容已与主站同步</small></div><button class="primary-button" data-new-course type="button"><span data-icon="plus"></span>新建课程</button></div>
  </header>
  <section class="content-overview-strip" id="contentOverviewStrip" aria-label="内容运营概览">${contentOverviewStrip()}</section>
  <div id="contentHealthPanel" class="content-health-slot">${contentHealthPanel()}</div>
  <section class="content-workbench-shell"><header class="content-workbench-heading"><div><span class="eyebrow">运营工作区</span><strong>选择要处理的内容模块</strong></div><span><i aria-hidden="true"></i>数据来自当前生产环境</span></header>${contentTabs()}</section>
  <div id="contentSystemBody" role="tabpanel" aria-labelledby="contentTab_${state.contentTab}"><div class="panel"><div class="empty-state">正在读取内容数据…</div></div></div>`
  renderIcons(main)
  main.querySelector('[data-new-course]').onclick=()=>openCourseEditor()
  document.querySelectorAll('[data-content-tab]').forEach(button=>button.onclick=async()=>{
    state.contentTab=button.dataset.contentTab
    document.querySelectorAll('[data-content-tab]').forEach(item=>{const selected=item===button;item.classList.toggle('is-active',selected);item.setAttribute('aria-selected',String(selected))})
    document.querySelector('#contentSystemBody')?.setAttribute('aria-labelledby',`contentTab_${state.contentTab}`)
    await renderContentTab()
  })
  await Promise.all([loadContentOverview(),renderContentTab()])
}
async function renderSystemSettingsPage(){
  const main=document.querySelector('#adminMain');state.contentTab='system';state.systemConfigDirty=false
  main.innerHTML=`<header class="page-head system-settings-head"><div class="system-title-lockup"><span class="system-title-icon" data-icon="settings" aria-hidden="true"></span><div><span class="eyebrow">平台基础设施</span><h1>系统设置</h1><p>集中管理版本发布、用户入口、商业参数与平台服务连接。</p></div></div><div class="system-head-actions"><div class="system-safety-state"><span data-icon="shield" aria-hidden="true"></span><div><strong>生产配置</strong><small>敏感内容已脱敏</small></div></div><button class="secondary-button" id="reloadSystemSettings" type="button"><span data-icon="refresh"></span>重新读取</button></div></header><div id="contentSystemBody"><section class="system-overview-strip" aria-label="系统配置概览">${'<div class="system-overview-skeleton"></div>'.repeat(4)}</section><div class="panel"><div class="empty-state">正在读取系统配置…</div></div></div>`
  renderIcons(main)
  main.querySelector('#reloadSystemSettings').onclick=async event=>{if(state.systemConfigDirty&&!await confirmAction('放弃尚未保存的修改？','重新读取会用服务器配置覆盖当前页面中的修改。','重新读取',true))return;event.currentTarget.disabled=true;state.systemConfig=null;state.systemConfigDirty=false;try{await loadContentOverview();toast('系统配置已重新读取','success')}catch(error){handleError(error)}finally{event.currentTarget.disabled=false}}
  await loadContentOverview()
}

async function setView(view) {
  if (state.view === 'system-settings' && state.systemConfigDirty) {
    if (!await confirmAction('放弃尚未保存的修改？','离开系统设置会丢失当前页面中尚未保存的内容。','放弃修改',true)) return
    state.systemConfigDirty = false
  }
  if (state.view === 'ai-operations' && view !== 'ai-operations') {
    if (state.aiTab === 'memory') { pausePlatformMemoryCompressionPolling(); stopPlatformMemoryConsistencyPolling() }
    state.realtime.aiOperationsRequestSeq += 1
    state.realtime.aiOperationsAbortController?.abort()
  }
  state.view = view
  window.scrollTo(0,0)
  document.querySelector('#adminMain').classList.toggle('ai-operations-page', view === 'ai-operations')
  document.querySelector('#adminMain').classList.toggle('overview-page', view === 'overview')
  document.querySelector('#adminMain').classList.toggle('notification-center-page', view === 'notifications')
  document.querySelector('#adminMain').classList.toggle('content-operations-page', view === 'content-operations')
  document.querySelector('#adminMain').classList.toggle('system-settings-page', view === 'system-settings')
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    const active = item.dataset.view === view
    item.classList.toggle('is-active', active)
    if (active) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  document.querySelector('#currentViewName').textContent = viewLabels[view] || '管理工作台'
  const preservedSection=view==='system-settings'?new URLSearchParams(location.search).get('section'):''
  history.replaceState({}, '', `/admin/${view === 'overview' ? '' : `?view=${view}${preservedSection?`&section=${encodeURIComponent(preservedSection)}`:''}`}`)
  document.body.classList.remove('nav-open')
  document.querySelector('#drawerScrim').hidden = true
  try {
    if (view === 'users') await renderUsers()
    else if (view === 'notifications') await renderNotificationCenterPage()
    else if (view === 'commercial') await renderCommercial()
    else if (view === 'ai-operations') await renderAiOperations()
    else if (view === 'risk-audit') await renderRiskAudit()
    else if (view === 'management-audit') await renderManagementAudit()
    else if (view === 'content-operations') await renderContentOperationsPage()
    else if (view === 'system-settings') await renderSystemSettingsPage()
    else await renderOverview()
    document.querySelector('#adminMain').focus({ preventScroll:true })
  } catch (error) { handleError(error) }
}

let adminAccountCenterPreviousFocus = null
let adminAccountCenterPreviousOverflow = ''

function openAdminAccountCenter(tab = 'overview') {
  const modal = document.querySelector('#adminAccountModal')
  const frame = document.querySelector('#adminAccountFrame')
  if (!modal || !frame) return
  adminAccountCenterPreviousFocus = document.activeElement
  adminAccountCenterPreviousOverflow = document.body.style.overflow
  const nextSrc = `/account/?embed=admin&tab=${encodeURIComponent(tab)}`
  if (!frame.getAttribute('src')) frame.src = nextSrc
  else if (frame.contentWindow) frame.contentWindow.postMessage({ type:'account-center-tab', tab }, window.location.origin)
  modal.hidden = false
  modal.setAttribute('aria-hidden', 'false')
  document.body.style.overflow = 'hidden'
  document.querySelector('#adminAccountCloseButton')?.focus()
}

function closeAdminAccountCenter() {
  const modal = document.querySelector('#adminAccountModal')
  if (!modal || modal.hidden) return
  modal.hidden = true
  modal.setAttribute('aria-hidden', 'true')
  document.body.style.overflow = adminAccountCenterPreviousOverflow
  if (adminAccountCenterPreviousFocus instanceof HTMLElement) adminAccountCenterPreviousFocus.focus()
  adminAccountCenterPreviousFocus = null
}

function handleAdminAccountCenterMessage(event) {
  const frame = document.querySelector('#adminAccountFrame')
  if (event.origin !== window.location.origin || event.source !== frame?.contentWindow) return
  if (event.data?.type === 'account-center-close') {
    closeAdminAccountCenter()
    return
  }
  if (event.data?.type === 'account-session-logout') {
    closeAdminAccountCenter()
    location.replace(`/auth/login?next=${encodeURIComponent('/admin/')}`)
    return
  }
  if (event.data?.type === 'account-profile-updated' && event.data.user) applyAdminProfile({ ...(state.profile || {}), ...event.data.user })
}

document.querySelectorAll('.nav-item[data-view]').forEach(item => item.addEventListener('click', () => setView(item.dataset.view)))
document.querySelector('#refreshButton').addEventListener('click', () => setView(state.view))
document.querySelector('#themeToggleButton').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  applyAdminTheme(current === 'dark' ? 'light' : 'dark', { persist:true })
})
window.addEventListener('storage', event => {
  if (event.key === ADMIN_THEME_KEY) applyAdminTheme(event.newValue === 'dark' ? 'dark' : 'light')
})
document.addEventListener('focusout', () => setTimeout(flushPendingAdminRealtimeRefresh, 0))
document.addEventListener('click', () => setTimeout(flushPendingAdminRealtimeRefresh, 0))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    flushPendingAdminRealtimeRefresh()
    if (!state.realtime.ws && !state.realtime.authFailed) connectAdminRealtime()
    calibrateSchedulerRuntimeSilently()
  }
})
window.addEventListener('beforeunload', event => {
  if (state.platformMemoryEditorDirty) {
    event.preventDefault()
    event.returnValue = '策略记忆原文有未保存的修改。'
  } else if (state.systemConfigDirty) {
    event.preventDefault()
    event.returnValue = '系统设置有未保存的修改。'
  }
  if (state.realtime.reconnectTimer) clearTimeout(state.realtime.reconnectTimer)
  stopAdminRealtimeHeartbeat()
  stopAiSchedulerTicker()
  state.realtime.aiOperationsAbortController?.abort()
  try { state.realtime.ws?.close(1000, 'page_unload') } catch {}
})
document.querySelector('#accountButton').addEventListener('click', () => openAdminAccountCenter('overview'))
document.querySelectorAll('[data-close-modal]').forEach(item => item.addEventListener('click', closeUserModal))
document.querySelectorAll('#contentModal [data-close-content-modal]').forEach(item => item.addEventListener('click', closeCourseEditor))
document.querySelectorAll('#entityModal > [data-close-entity-modal], #entityModal .modal-header [data-close-entity-modal]').forEach(item => item.addEventListener('click', closeEntityModal))
document.querySelectorAll('[data-close-admin-account]').forEach(item => item.addEventListener('click', closeAdminAccountCenter))
window.addEventListener('message', handleAdminAccountCenterMessage)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  if (!document.querySelector('#adminAccountModal').hidden) closeAdminAccountCenter()
  else if (!document.querySelector('#entityModal').hidden) closeEntityModal()
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
    connectAdminRealtime()
    const requested = new URLSearchParams(location.search).get('view')
    const legacyView = requested === 'content-system' ? 'content-operations' : requested
    const requestedUserId = new URLSearchParams(location.search).get('userId')
    if (legacyView === 'notifications' && /^\d+$/.test(String(requestedUserId || ''))) {
      state.notificationCenter.scope = 'user'
      state.notificationCenter.userId = String(requestedUserId)
      state.notificationCenter.userSearch = `用户 #${requestedUserId}`
      state.notificationCenter.tab = 'compose'
    }
    await setView(['users','notifications','commercial','ai-operations','risk-audit','management-audit','content-operations','system-settings'].includes(legacyView) ? legacyView : 'overview')
  } catch (error) { handleError(error) }
}
bootstrap()
document.addEventListener('click',async event=>{const button=event.target.closest('[data-platform-memory-action="cancel"]');if(!button)return;event.preventDefault();if(state.platformMemoryEditorDirty&&!await confirmAction('放弃未保存的记忆原文？','取消编辑会丢弃当前草稿并返回已保存的阅读预览。','放弃编辑',true))return;state.platformMemoryEditorDirty=false;state.platformMemoryEditorDraft=null;state.platformMemoryViewMode='preview';renderPlatformMemory()})
document.addEventListener('click',async event=>{const button=event.target.closest('[data-platform-memory-restore]');if(!button)return;event.preventDefault();const strategyId=Number(state.platformMemoryStrategyId||0),revisionId=Number(button.dataset.platformMemoryRestore||0),library=state.platformMemory?.detail?.library;if(!strategyId||!revisionId||!library||adminStrategyMemoryCompressionActive(state.platformMemoryCompressionJob))return;if(!await confirmAction('恢复记忆库历史版本','当前内容不会被删除，而是保留在版本历史中；恢复操作会创建一个新的当前版本。','恢复为新版本'))return;button.disabled=true;try{await api(`/api/ai/strategy-memories/${strategyId}/revisions/${revisionId}/restore`,{method:'POST',body:JSON.stringify({expected_version_no:Number(library.version_no)})});toast('历史内容已恢复为新版本','success');state.platformMemory.detail=await api(`/api/ai/strategy-memories/${strategyId}`);state.platformMemoryEditorDirty=false;state.platformMemoryEditorDraft=null;state.platformMemoryViewMode='preview';await loadPlatformMemoryPreview(strategyId);renderPlatformMemory()}catch(error){handleError(error)}finally{button.disabled=false}})
