export function compareProtocolRoutes(actual, exceptions) {
  const key = row => `${row.method} ${row.path}`
  if (!Array.isArray(exceptions) || exceptions.some(row => !['GET', 'POST'].includes(row.method)
    || typeof row.path !== 'string' || !row.path.startsWith('/') || /[*:{}?]/.test(row.path)
    || row.path === '/api/v4' || row.path.startsWith('/api/v4/')
    || typeof row.reason !== 'string' || !row.reason.trim())
    || new Set(exceptions.map(key)).size !== exceptions.length) throw Error('api_protocol_exceptions_invalid')
  const expected = new Set(exceptions.map(key)), observed = new Set(actual.map(key))
  const unexpected = actual.filter(row => !expected.has(key(row)))
  const missing = exceptions.filter(row => !observed.has(key(row)))
  const duplicates = actual.filter((row, index) => actual.findIndex(candidate => key(candidate) === key(row)) !== index)
  return { passed: !unexpected.length && !missing.length && !duplicates.length, unexpected, missing, duplicates }
}
