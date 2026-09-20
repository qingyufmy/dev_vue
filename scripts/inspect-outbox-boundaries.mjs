import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { sourceFiles } from './lib/module-dependency-graph.mjs'
import { inspectOutboxSource } from './lib/outbox-write-boundary.mjs'

const root = resolve(import.meta.dirname, '..')
const findings = sourceFiles(resolve(root, 'server/src')).flatMap(file =>
  inspectOutboxSource(readFileSync(file, 'utf8'), relative(root, file).replaceAll('\\', '/')))
console.log(JSON.stringify({ passed: findings.length === 0, findings,
  scope: 'Literal outbox SQL writer roles; not transaction, payload or dynamic SQL verification' }, null, 2))
if (findings.length) process.exitCode = 1
