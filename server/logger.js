// server/logger.js — 轻量级结构化日志

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || LOG_LEVELS.info

function formatTime() {
  const d = new Date(Date.now() + 8 * 3600_000)
  return d.toISOString().replace('T', ' ').substring(0, 19)
}

function log(level, module, message, data) {
  if (LOG_LEVELS[level] < currentLevel) return
  const time = formatTime()
  const prefix = `[${time}] [${level.toUpperCase()}] [${module}]`
  const msg = data ? `${message} ${JSON.stringify(data)}` : message
  if (level === 'error') {
    console.error(`${prefix} ${msg}`)
  } else if (level === 'warn') {
    console.warn(`${prefix} ${msg}`)
  } else {
    console.log(`${prefix} ${msg}`)
  }
}

export function createLogger(module) {
  return {
    debug: (msg, data) => log('debug', module, msg, data),
    info: (msg, data) => log('info', module, msg, data),
    warn: (msg, data) => log('warn', module, msg, data),
    error: (msg, data) => log('error', module, msg, data),
  }
}

export default { createLogger }
