import ts from 'typescript'
import { gunzipSync } from 'node:zlib'

const accountKey = /^(?:(?:source|target|current|owner)[_]?)*(?:trading[_]?)?account[_]?id$/i
const accountContainer = /^(?:trading[_]?)?accounts?$/i
export function inspectAccountJson(text, sourceIds, mergedIds) {
  const result = { invalidJson: 0, encodedJson: 0, limited: 0, references: 0, sourceMatches: 0, mergedMatches: 0, otherValues: 0, unsafeNumbers: 0 }
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) return { ...result, limited: 1 }
  if (text.startsWith('gzip-base64:')) {
    result.encodedJson++
    try { text = gunzipSync(Buffer.from(text.slice('gzip-base64:'.length), 'base64'), { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8') }
    catch { return { ...result, invalidJson: 1 } }
  }
  let value
  try { value = JSON.parse(text) } catch { return { ...result, invalidJson: 1 } }
  const stack = [{ value, account: false, depth: 0 }]
  let visited = 0
  while (stack.length) {
    if (++visited > 1000000) { result.limited++; break }
    const item = stack.pop()
    if (item.depth > 100) { result.limited++; continue }
    if (Array.isArray(item.value)) {
      for (const value of item.value) stack.push({ value, account: item.account, depth: item.depth + 1 })
    } else if (item.value && typeof item.value === 'object') {
      for (const [key, value] of Object.entries(item.value)) {
        if (accountKey.test(key) || (key === 'id' && item.account)) {
          result.references++
          if (typeof value === 'number' && !Number.isSafeInteger(value)) result.unsafeNumbers++
          else if (typeof value === 'string' || typeof value === 'number') {
            const id = String(value)
            if (sourceIds.has(id)) result.sourceMatches++
            if (mergedIds.has(id)) result.mergedMatches++
            if (!sourceIds.has(id)) result.otherValues++
          } else result.otherValues++
        }
        stack.push({ value, account: accountContainer.test(key), depth: item.depth + 1 })
      }
    }
  }
  return result
}

export function accountRootSourceReferences(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw Error('account_reference_source_parse')
  const references = []
  function visit(node) {
    const sql = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node)
      ? node.head.text + node.templateSpans.map(span => '__DYNAMIC__' + span.literal.text).join('') : null
    if (sql && /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(sql)
      && /\b(?:FROM|JOIN|INTO|UPDATE)\s+`?trading_accounts\b/i.test(sql)) {
      references.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        operation: /^\s*(\w+)/.exec(sql)[1].toUpperCase(), dynamic: sql.includes('__DYNAMIC__') })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return references
}
