import { isIP } from 'node:net'

function normalizeHostname(value) {
  const text = String(value || '').trim().toLowerCase().replace(/\.$/, '')
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
}

function parseRequestOrigin(value) {
  const text = String(value || '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (url.origin !== text.replace(/\/$/, '')) return null
    return url
  } catch {
    return null
  }
}

function parseProtocolIndependentRule(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text || /[/?#@]/.test(text)) return null
  const subdomainsOnly = text.startsWith('*.')
  const authority = subdomainsOnly ? text.slice(2) : text
  try {
    const url = new URL(`cors-rule://${authority}`)
    const hostname = normalizeHostname(url.hostname)
    if (!hostname || url.username || url.password || url.pathname !== '') return null
    return { hostname, port:url.port, subdomainsOnly }
  } catch {
    return null
  }
}

export function parseCorsOrigins(value = '') {
  return [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))]
}

export function corsOriginMatchesRule(origin, rule) {
  const originUrl = parseRequestOrigin(origin)
  const ruleText = String(rule || '').trim()
  if (!originUrl || !ruleText) return false
  if (ruleText === '*') return true

  if (ruleText.includes('://')) {
    const ruleUrl = parseRequestOrigin(ruleText)
    return Boolean(ruleUrl && ruleUrl.origin === originUrl.origin)
  }

  const parsedRule = parseProtocolIndependentRule(ruleText)
  if (!parsedRule) return false
  const originHostname = normalizeHostname(originUrl.hostname)
  const exactHost = originHostname === parsedRule.hostname
  const childHost = originHostname.endsWith(`.${parsedRule.hostname}`)
  const domainMayHaveChildren = isIP(parsedRule.hostname) === 0 && parsedRule.hostname !== 'localhost'
  const hostMatches = parsedRule.subdomainsOnly
    ? domainMayHaveChildren && !exactHost && childHost
    : exactHost || (domainMayHaveChildren && childHost)
  if (!hostMatches) return false

  const effectiveOriginPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80')
  return parsedRule.port ? parsedRule.port === effectiveOriginPort : originUrl.port === ''
}

export function isCorsOriginAllowed(origin, rules = []) {
  return rules.some(rule => corsOriginMatchesRule(origin, rule))
}
