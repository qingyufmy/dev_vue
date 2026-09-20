import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'
import { roles, selectRoles, defaultProfile } from './lib/local-v4-roles.mjs'
import { probe, runSupervisor } from './lib/local-v4-supervisor.mjs'
import { localAccountEnvironment } from './run-local-account-api.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, '../.local-runtime/dev-vue/unified')
const action = process.argv[2] || 'status', profile = process.argv[3] || defaultProfile
const labels = { stopped: '未运行', ready: '就绪', degraded: '运行中/业务异常', unready: '未就绪', conflict: '端口冲突或无法确认', 'external-web': '页面可访问' }
async function controller(method = 'GET', endpoint = '/status') {
  const state = JSON.parse(await readFile(resolve(directory, 'controller.json'), 'utf8'))
  if (state.root !== root || !Number.isInteger(state.port) || state.port !== 3040 || !/^[a-f0-9]{64}$/.test(state.token)) throw new Error('controller state invalid')
  const response = await fetch(`http://127.0.0.1:${state.port}${endpoint}`, { method, headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`controller HTTP ${response.status}`)
  return endpoint === '/status' ? response.json() : response.text()
}
async function preflight(selected) {
  const base = parse(await readFile(resolve(root, 'server/.env')))
  const localPath = process.env.LOCAL_V4_ACCOUNT_ENV || resolve(root, '../.local-runtime/dev-vue/account-api.env')
  const local = parse(await readFile(localPath))
  localAccountEnvironment(base, local)
  if (base.MYSQL_HOST !== '192.168.1.254') throw new Error('local development database host mismatch')
  const overrides = {
    V4_API_PORT: 3010, V4_BROWSER_REALTIME_PORT: 3011, V4_BRIDGE_GATEWAY_PORT: 3012,
    V4_OUTBOX_HEALTH_PORT: 3020, V4_EXECUTION_HEALTH_PORT: 3021, V4_ANALYSIS_SCHEDULER_HEALTH_PORT: 3022,
    V4_ANALYSIS_HEALTH_PORT: 3023, V4_TRADER_HEALTH_PORT: 3024, V4_RISK_HEALTH_PORT: 3025,
    V4_REVIEW_HEALTH_PORT: 3026, V4_HISTORY_SCHEDULER_HEALTH_PORT: 3027,
    V4_EXECUTION_SCHEDULER_HEALTH_PORT: 3028, V4_PUBLIC_MARKET_HEALTH_PORT: 3029, V4_RISK_SUMMARY_HEALTH_PORT: 3030,
  }
  for (const [key, port] of Object.entries(overrides)) if (base[key] && Number(base[key]) !== port) throw new Error(`${key} differs from local port map`)
  for (const role of selected) await access(resolve(root, role.web
    ? `frontend/apps/${role.id === 'auth-web' ? 'auth' : 'trade'}/node_modules/vite/dist/node/index.js`
    : `server/dist-v4/entrypoints/${role.id}.js`))
}
try {
  if (action === 'status') {
    const owner = await controller().catch(() => null)
    const rows = await Promise.all(roles.map(async role => {
      const state = await probe(role)
      return { 服务: role.label, 端口: role.port, 状态: state === 'stopped' && owner?.owned.includes(role.id) ? '进程运行，端口未就绪' : labels[state],
        管理: owner?.owned.includes(role.id) ? '总控制台' : owner?.failures.includes(role.id) ? '启动失败/重启已停止' : state === 'stopped' ? '--' : '外部实例' }
    }))
    console.table(rows)
    console.log(owner ? `总控制台 PID ${owner.pid}，运行模式：${owner.profile ?? '旧版控制台未登记'}。` : '总控制台未运行。')
    const unavailable = rows.filter(row => [3025,3021,3028,3012].includes(row.端口) && row.状态 !== '就绪')
    if (unavailable.length) console.log(`交易执行链路尚未就绪：${unavailable.map(row => `${row.服务}（${row.状态}）`).join('、')}。账户开关开启不代表后台可执行。`)
    else console.log('执行相关服务已就绪；实际交易结果仍以终端回执为准。')
  } else if (action === 'stop') {
    const owner = await controller()
    console.log(`正在停止总控制台，运行模式：${owner.profile ?? '旧版控制台未登记'}。`)
    console.log(await controller('POST', '/stop'))
    let stopped = false
    for (let i = 0; i < 40; i++) {
      await new Promise(done => setTimeout(done, 500))
      try { await controller() } catch { stopped = true; break }
    }
    if (!stopped) throw new Error('停止仍在进行，请检查总控制台；未宣称停止完成')
    console.log('总控制台已停止。外部实例未停止。')
  } else if (['start', 'check'].includes(action)) {
    const selected = selectRoles(profile)
    await preflight(selected)
    console.log(`配置与构建文件检查通过，范围 ${profile}：${selected.map(role => role.label).join('、')}`)
    console.log(profile === 'full' ? '完整交易模式：包含订单执行及执行恢复调度，启动后会处理符合条件的交易任务。' : '分析调试模式：不启动订单执行、执行恢复调度和复盘，不能用于完整交易验收。')
    if (action === 'start') await runSupervisor({ root, directory, roles: selected, profile,
      commandFor: role => ({ file: process.execPath, args: [resolve(root, 'scripts/local-v4-child.mjs'), role.id] }) })
  } else throw new Error('usage: local-v4.mjs start|status|stop|check [core|full]')
} catch (error) { console.error(error.code || error.message); process.exitCode = 1 }
