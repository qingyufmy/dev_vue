import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = fs.readFileSync(new URL('../public/ai/index.html', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../public/ai/styles.css', import.meta.url), 'utf8')
const js = fs.readFileSync(new URL('../public/ai/app.js', import.meta.url), 'utf8')

describe('bridge control center frontend contract', () => {
  it('renders status, latency, terminal detail and explicit start or pause controls', () => {
    expect(html).toContain('id="bridgeControlLatency"')
    expect(html).toContain('id="bridgeControlTerminals"')
    expect(html).toContain('id="bridgeRuntimeToggle"')
    expect(html).toContain('停止连接业务服务器')
    expect(css).toContain('.bridge-metrics')
    expect(css).toContain('@media (max-width: 680px)')
  })

  it('polls the persisted runtime state and sends start or pause intent to the server', () => {
    expect(js).toContain('api("/api/bridge/runtime-control"')
    expect(js).toContain('api("/api/bridge/runtime-control", {')
    expect(js).toContain('body:{ enabled }')
    expect(js).toContain('setInterval(() => loadBridgeControlStatus({ quiet:true }), 3000)')
    expect(js).toContain('data?.desired_state === "paused"')
  })

  it('switches an ordinary paused bridge to observer data without waiting for disconnect timeout', () => {
    expect(js).toContain('async function enterBridgeObserverMode')
    expect(js).toContain('if (!enabled) {\n      await enterBridgeObserverMode({ paused:true });')
    expect(js).toContain('const accessRes = await api("/api/ai/access-context")')
    expect(js).toContain('await loadObserverChannels()')
    expect(js).toContain('notifyObserverChannelSelection()')
    expect(js).toContain('"观摩模式 · 桥接已暂停"')
  })

  it('keeps observer data visible while a resumed bridge is reconnecting', () => {
    expect(js).toContain('"观摩模式 · 桥接恢复中"')
    expect(js).toContain('renderGatewayConnectionBadge(false, state._usingFallback === true)')
    expect(js).toContain('void enterBridgeObserverMode({')
  })
})
