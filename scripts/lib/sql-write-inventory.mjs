import ts from 'typescript'

// Source evidence only: no database access and no inference of business ownership.
// Tokenizing quotes/comments prevents SET values and comments from becoming writes.
export function sqlTokens(sql) {
  return [...sql.matchAll(/\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*|'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`|[a-zA-Z_][a-zA-Z_0-9$]*|[^\s]/g)]
    .map(match => match[0])
    .filter(token => !token.startsWith('/*') && !token.startsWith('--') && !token.startsWith('#'))
}

const dynamicToken = '__SQL_INTERPOLATION__'
const identifier = token => token && (/^[a-zA-Z_][a-zA-Z_0-9$]*$/.test(token) || /^`[^`]+`$/.test(token))

export function inspectSqlWrite(sql) {
  const parts = sqlTokens(sql)
  const upper = parts.map(part => part.toUpperCase())
  const operation = upper[0]
  if (!['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH', 'TRUNCATE', 'ALTER', 'CREATE', 'DROP', 'CALL'].includes(operation)) return null
  if (!['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(operation)) {
    return { operation, table: null, review: 'unsupported-statement', dynamic: sql.includes(dynamicToken) }
  }
  let cursor = 1
  while (['LOW_PRIORITY', 'HIGH_PRIORITY', 'DELAYED', 'IGNORE', 'QUICK'].includes(upper[cursor])) cursor++
  if (['INSERT', 'REPLACE'].includes(operation) && upper[cursor] === 'INTO') cursor++
  if (operation === 'DELETE') {
    if (upper[cursor] !== 'FROM') return { operation, table: null, review: 'multi-table-or-incomplete-delete', dynamic: sql.includes(dynamicToken) }
    cursor++
  }
  const name = parts[cursor++]
  const result = { operation, table: null, review: null, dynamic: sql.includes(dynamicToken) }
  if (!identifier(name) || name.includes(dynamicToken)) return { ...result, review: 'dynamic-or-incomplete-target' }
  let table = name.replaceAll('`', '')
  if (parts[cursor] === '.') {
    const qualified = parts[cursor + 1]
    if (!identifier(qualified) || qualified.includes(dynamicToken)) return { ...result, review: 'dynamic-or-incomplete-target' }
    table += `.${qualified.replaceAll('`', '')}`
    cursor += 2
  }
  // Only list a resolved target for supported single-table shapes. Aliases/JOINs
  // stay unclassified rather than silently missing another updated table.
  const expected = operation === 'UPDATE' ? ['SET']
    : operation === 'DELETE' ? ['WHERE', 'ORDER', 'LIMIT', ';']
      : ['(', 'VALUES', 'VALUE', 'SET', 'SELECT']
  if (parts[cursor] && !expected.includes(upper[cursor])) return { ...result, review: 'unsupported-target-shape' }
  if (!parts[cursor] && operation !== 'DELETE') return { ...result, review: 'incomplete-statement' }
  const separator = parts.indexOf(';')
  if (separator >= 0 && separator < parts.length - 1) return { ...result, review: 'multiple-statements' }
  return { ...result, table }
}

export function inventorySource(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, '\n')}`)
  const writes = [], indirectCalls = []
  const writer = file.match(/server\/src\/modules\/([^/]+)\//)?.[1] ?? `@${file.split('/')[2] ?? 'unknown'}`
  const location = node => ({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, writer })
  const literalSql = node => ts.isStringLiteralLike(node) ? node.text
    : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => dynamicToken + span.literal.text).join('') : null
  function visit(node) {
    const sql = literalSql(node)
    if (sql !== null) {
      const write = inspectSqlWrite(sql)
      if (write) writes.push({ ...location(node), ...write })
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['execute', 'query'].includes(node.expression.name.text)) {
      const argument = node.arguments[0]
      const argumentSql = argument ? literalSql(argument) : null
      if (argumentSql === null || sqlTokens(argumentSql)[0]?.includes(dynamicToken)) {
        indirectCalls.push({ ...location(node), method: node.expression.name.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { writes, indirectCalls }
}

export function summarizeWrites(sources) {
  const writes = sources.flatMap(source => source.writes)
  const indirectCalls = sources.flatMap(source => source.indirectCalls)
  const names = [...new Set(writes.map(write => write.table).filter(Boolean))].sort()
  const tables = names.map(table => {
    const evidence = writes.filter(write => write.table === table)
    return { table, writers: [...new Set(evidence.map(write => write.writer))].sort(), evidence }
  })
  return { tables, unresolved: writes.filter(write => !write.table), indirectCalls,
    counts: { tables: tables.length, writeCandidates: writes.length,
      multipleWriterTables: tables.filter(table => table.writers.length > 1).length,
      unresolved: writes.filter(write => !write.table).length, indirectCalls: indirectCalls.length } }
}
