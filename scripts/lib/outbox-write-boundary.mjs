import ts from 'typescript'
import { inspectSqlWrite, sqlTokens } from './sql-write-inventory.mjs'

// Literal SQL only. This checks writer roles, not transaction membership or payloads.
export function inspectOutboxSource(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw new Error(`outbox_source_parse_failed:${file}`)
  const findings = []
  function visit(node) {
    const sql = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node)
      ? node.head.text + node.templateSpans.map(span => '__SQL_INTERPOLATION__' + span.literal.text).join('') : null
    if (sql !== null) {
      const words = sqlTokens(sql).map(word => word.replaceAll('`', '').toUpperCase())
      const write = inspectSqlWrite(sql)
      if (write && words.includes('OUTBOX_EVENTS')) {
        const dispatcher = file.startsWith('server/src/outbox/infrastructure/')
        const producer = /^server\/src\/modules\/[^/]+\/infrastructure\//.test(file)
        const insertOnly = write.operation === 'INSERT' && !words.includes('UPDATE') && !words.includes('REPLACE')
        if (write.table?.toLowerCase() !== 'outbox_events' || write.review
          || !(dispatcher && write.operation === 'UPDATE' || producer && insertOnly)) {
          findings.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            code: 'outbox_write_role_invalid', operation: write.operation })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return findings
}
