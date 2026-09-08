import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { sourceFiles } from './lib/module-dependency-graph.mjs'
import { inventorySource, summarizeWrites } from './lib/sql-write-inventory.mjs'

const root = resolve(import.meta.dirname, '..')
const files = sourceFiles(resolve(root, 'server/src'))
const report = summarizeWrites(files.map(file => inventorySource(readFileSync(file, 'utf8'), relative(root, file).replaceAll('\\', '/'))))
console.log(JSON.stringify({ version: 1, scope: 'server/src source candidates; not database or ownership verification',
  files: files.length, limitations: [
    'Literal SQL candidates may be unused; writers describe source directories, not approved owners.',
    'Dynamic targets, CTEs, multi-table shapes and indirect execute/query calls require manual review.',
    'No dataflow, imported SQL, ORM, triggers, stored procedure bodies, legacy code or migrations are analyzed.',
    'Execute/query method names are not type-resolved; indirect calls include business methods. MySQL executable comments and injected SQL fragments are not expanded.',
    'Single source writer does not prove business ownership; multi-writer tables may include legitimate transactional outbox producers.',
  ], ...report }, null, 2))
