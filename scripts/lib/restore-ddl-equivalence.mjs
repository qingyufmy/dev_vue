// Only accept MySQL's redundant explicit charset rendering after independent
// full column metadata equality. No generic whitespace/default/index rewriting.
export function equivalentRestoredDdl(source, restored, columns) {
  if (source === restored) return { equivalent: true, differences: [] }
  const before = source.split('\n'), after = restored.split('\n'), differences = []
  if (before.length !== after.length) return { equivalent: false, differences }
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue
    const column = columns.find(column => column.characterSet === 'utf8mb4' && column.collation === 'utf8mb4_unicode_ci'
      && ['varchar', 'mediumtext', 'enum'].includes(column.dataType)
      && /^[a-z][a-z0-9_]*$/.test(column.name)
      && before[i].startsWith(`  \`${column.name}\` ${column.columnType} COLLATE utf8mb4_unicode_ci `))
    if (!column) return { equivalent: false, differences }
    const prefix = `  \`${column.name}\` ${column.columnType} `
    if (after[i] !== prefix + 'CHARACTER SET utf8mb4 ' + before[i].slice(prefix.length)) return { equivalent: false, differences }
    differences.push({ column: column.name, change: 'explicit_redundant_utf8mb4_charset' })
  }
  return { equivalent: true, differences }
}
