import { describe, it, expect } from 'vitest'
import {
  round2, round3, round5, clamp,
  parseTimeframeTags, stripTimeframeTags,
  signalTtlSeconds, signalAgeSeconds, attachSignalTiming,
  timeframeIntervalMs,
  compactRates, utcToMt5Time,
  aiFailureHold, parseJsonObject,
  DEFAULT_PROMPT, STRATEGY_TIMEFRAME_COUNTS
} from '../../server/routes/ai/utils.js'

describe('round2/round3/round5', () => {
  it('round2 保留2位小数', () => {
    expect(round2(1.2345)).toBe(1.23)
    expect(round2(1.235)).toBe(1.24)
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })

  it('round3 保留3位小数', () => {
    expect(round3(1.23456)).toBe(1.235)
    expect(round3(1.2344)).toBe(1.234)
  })

  it('round5 保留5位小数', () => {
    expect(round5(1.23456789)).toBe(1.23457)
  })
})

describe('clamp', () => {
  it('限制在范围内', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('parseTimeframeTags', () => {
  it('解析 MTF 标签', () => {
    const tags = parseTimeframeTags('分析 {{MTF:M5:100}} {{MTF:H1:80}}', 'manual')
    expect(tags).toEqual([
      { tf: 'M5', count: 100 },
      { tf: 'H1', count: 80 }
    ])
  })

  it('解析 ATF 标签', () => {
    const tags = parseTimeframeTags('分析 {{ATF:M5:60}}', 'auto')
    expect(tags).toEqual([{ tf: 'M5', count: 60 }])
  })

  it('解析 CTF 标签', () => {
    const tags = parseTimeframeTags('分析 {{CTF:M5:50}}', 'close')
    expect(tags).toEqual([{ tf: 'M5', count: 50 }])
  })

  it('空提示词返回空数组', () => {
    expect(parseTimeframeTags('', 'manual')).toEqual([])
    expect(parseTimeframeTags(null, 'manual')).toEqual([])
  })

  it('限制 count 范围 10-500', () => {
    const tags = parseTimeframeTags('{{MTF:M5:5}}', 'manual')
    expect(tags[0].count).toBe(10)

    const tags2 = parseTimeframeTags('{{MTF:M5:999}}', 'manual')
    expect(tags2[0].count).toBe(500)
  })
})

describe('stripTimeframeTags', () => {
  it('移除所有时间框架标签', () => {
    const result = stripTimeframeTags('分析 {{MTF:M5:100}} 数据 {{ATF:H1:80}}')
    expect(result).toBe('分析  数据')
  })

  it('空输入返回原值', () => {
    expect(stripTimeframeTags('')).toBe('')
    expect(stripTimeframeTags(null)).toBe(null)
  })
})

describe('signalTtlSeconds', () => {
  it('返回正确的TTL', () => {
    expect(signalTtlSeconds('M1')).toBe(20)
    expect(signalTtlSeconds('M5')).toBe(45)
    expect(signalTtlSeconds('M15')).toBe(90)
    expect(signalTtlSeconds('H1')).toBe(300)
    expect(signalTtlSeconds('H4')).toBe(900)
    expect(signalTtlSeconds('D1')).toBe(1800)
  })

  it('未知时间框架返回默认120', () => {
    expect(signalTtlSeconds('X1')).toBe(120)
    expect(signalTtlSeconds('')).toBe(120)
  })
})

describe('signalAgeSeconds', () => {
  it('计算信号年龄', () => {
    const now = new Date()
    now.setSeconds(now.getSeconds() - 10)
    const createdAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
    const age = signalAgeSeconds(createdAt)
    expect(age).toBeGreaterThanOrEqual(9)
    expect(age).toBeLessThanOrEqual(11)
  })

  it('无效日期返回大值', () => {
    expect(signalAgeSeconds('invalid')).toBe(999999)
  })
})

describe('attachSignalTiming', () => {
  it('附加时间信息到信号', () => {
    const now = new Date()
    now.setSeconds(now.getSeconds() - 5)
    const createdAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
    const signal = { timeframe: 'M5', created_at: createdAt }
    const result = attachSignalTiming(signal)
    expect(result.ttl_seconds).toBe(45)
    expect(result.is_stale).toBe(false)
    expect(result.created_at_mt5).toBeTruthy()
  })
})

describe('timeframeIntervalMs', () => {
  it('返回正确的毫秒数', () => {
    expect(timeframeIntervalMs('M1')).toBe(60000)
    expect(timeframeIntervalMs('M5')).toBe(300000)
    expect(timeframeIntervalMs('H1')).toBe(3600000)
    expect(timeframeIntervalMs('D1')).toBe(86400000)
  })
})

describe('compactRates', () => {
  it('压缩K线数据', () => {
    const rates = [
      { time: '2026-01-01', open: '1.23456789', high: '1.24', low: '1.22', close: '1.23', tick_volume: '100' }
    ]
    const result = compactRates(rates)
    expect(result[0].open).toBe(1.23457)
    expect(result[0].tick_volume).toBe(100)
  })
})

describe('utcToMt5Time', () => {
  it('北京时间转MT5时间（减5小时）', () => {
    const result = utcToMt5Time('2026-06-26 15:30:00')
    expect(result).toBe('2026-06-26 10:30:00')
  })

  it('null 返回 null', () => {
    expect(utcToMt5Time(null)).toBe(null)
  })
})

describe('aiFailureHold', () => {
  it('返回 hold 信号', () => {
    const market = { symbol: 'XAUUSD', timeframe: 'M5' }
    const result = aiFailureHold(market, 'test_error')
    expect(result.signal_type).toBe('hold')
    expect(result.confidence).toBe(0.5)
    expect(result._inference_source).toBe('ai_error_hold')
  })
})

describe('parseJsonObject', () => {
  it('从内容中提取 JSON', () => {
    const content = '这是分析结果：\n```json\n{"key": "value"}\n```\n结束'
    const result = parseJsonObject(content)
    expect(result).toEqual({ key: 'value' })
  })

  it('无 JSON 抛出错误', () => {
    expect(() => parseJsonObject('no json here')).toThrow('ai_response_missing_json_object')
  })
})

describe('常量', () => {
  it('DEFAULT_PROMPT 存在', () => {
    expect(DEFAULT_PROMPT).toBeTruthy()
    expect(DEFAULT_PROMPT).toContain('signal_type')
  })

  it('STRATEGY_TIMEFRAME_COUNTS 包含必要时间框架', () => {
    expect(STRATEGY_TIMEFRAME_COUNTS).toHaveProperty('H4')
    expect(STRATEGY_TIMEFRAME_COUNTS).toHaveProperty('H1')
    expect(STRATEGY_TIMEFRAME_COUNTS).toHaveProperty('M15')
    expect(STRATEGY_TIMEFRAME_COUNTS).toHaveProperty('M5')
  })
})
