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
})
