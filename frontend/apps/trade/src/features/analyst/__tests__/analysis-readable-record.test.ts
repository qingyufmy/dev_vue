import { expect, it } from 'vitest'
import { readableRecord } from '../model/analysis-presentation'
it('renders nested prices without serializing internal metadata', () => {
  const rows = readableRecord({ h1: { latestConfirmedBi: { id: 'internal', endPrice: 4300, dir: 'up' } }, unknown_code: { token: 'secret' } })
  expect(rows).toEqual([
    { key: 'h1.latestConfirmedBi.endPrice', label: '1 小时 · 已确认的笔 · 终点价格', value: '4300' },
    { key: 'h1.latestConfirmedBi.dir', label: '1 小时 · 已确认的笔 · 方向', value: '向上' },
  ])
})
