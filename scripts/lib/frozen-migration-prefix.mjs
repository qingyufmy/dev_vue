// Existing reference journals are stored in lexical ID order (bootstrap last),
// while executable plans put bootstrap first. Validate both orders explicitly.
export function assertFrozenMigrationPrefix(reference, plan, protectedTables, errorCode) {
  const fail = () => { throw new Error(errorCode) }
  if (!Array.isArray(reference) || !reference.length || plan.length < reference.length) fail()
  const ids = reference.map(row => row.id)
  if (new Set(ids).size !== ids.length || ids.some((id, i) => typeof id !== 'string' || id !== [...ids].sort()[i])) fail()
  const bootstrap = reference.filter(row => row.id === 'bootstrap_v4_foundation_v1')
  if (bootstrap.length !== 1) fail()
  const ordered = [...bootstrap, ...reference.filter(row => row.id !== 'bootstrap_v4_foundation_v1')]
  if (ordered.some((row, i) => row.status !== 'completed' || row.id !== plan[i]?.id || row.checksum_sha256 !== plan[i]?.checksum)) fail()
  for (const migration of plan.slice(ordered.length)) {
    for (const statement of migration.statements) {
      const sql = statement.replace(/'(?:\\.|''|[^'])*'|"(?:\\.|""|[^"])*"/gs, "''")
      // Later dependencies on protected tables also need a new stage proof.
      const identifiers = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [])
      if (protectedTables.some(table => identifiers.has(table.toLowerCase()))) fail()
    }
  }
  return { frozenMigrationCount: ordered.length, appendedUnprovenMigrationCount: plan.length - ordered.length }
}
