import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLocalReexports } from '../scripts/lib/local-reexports.mjs'
import { buildDependencyGraph, serverBoundaryFindings } from '../scripts/lib/module-dependency-graph.mjs'

describe('local aliases of imported exports', () => {
  it('follows renamed imports, constant aliases, namespace members and default instances', () => {
    const exports = parseLocalReexports(`import { Repo as Hidden } from './mysql.js';
      import * as impl from './sdk.js';
      const Alias = (Hidden as unknown); const Second = Alias!;
      export { Second as Repository }; export const Client = impl['Client']; export default new Hidden();`, 'index.ts')
    expect(exports.map(value => [value.specifier, value.typeOnly])).toEqual([
      ['./mysql.js', false], ['./sdk.js', false], ['./mysql.js', false],
    ])
  })
  it('preserves type-only import and export semantics', () => {
    const exports = parseLocalReexports(`import type { Row } from './mysql.js'; import { Run } from './runtime.js';
      export { Row }; export type { Run }; export type RowAlias = Row; export type RuntimeType = typeof Run;`, 'index.ts')
    expect(exports.map(value => [value.specifier, value.typeOnly])).toEqual([
      ['./mysql.js', true], ['./runtime.js', true], ['./mysql.js', true], ['./runtime.js', true],
    ])
  })
  it('supports default and import-equals bindings', () => {
    expect(parseLocalReexports(`import Hidden from './default.js'; import Impl = require('./impl.js');
      export { Hidden }; export = Impl;`, 'index.ts').map(value => value.specifier)).toEqual(['./default.js', './impl.js'])
  })
  it('follows assertion and parenthesized type wrappers', () => {
    const exports = parseLocalReexports(`import { Repo } from './mysql.js';
      export const Public = <unknown>Repo; export type PublicType = (Repo);`, 'index.ts')
    expect(exports.map(value => [value.specifier, value.typeOnly])).toEqual([
      ['./mysql.js', false], ['./mysql.js', true],
    ])
  })
  it('does not mistake local declarations, shadowed nested exports or alias cycles for imported exports', () => {
    expect(parseLocalReexports(`import { Hidden } from './mysql.js';
      namespace Inner { export const Hidden = 1; }
      const a = b; const b = a; export { a }; export const local = 1;`, 'index.ts')).toEqual([])
  })
  it('follows an intermediate imported alias without duplicating physical edges', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurum-export-alias-'))
    try {
      const base = join(root, 'server/src/modules/a')
      mkdirSync(join(base, 'infrastructure'), { recursive: true })
      const files = [join(base, 'index.ts'), join(base, 'aliases.ts'), join(base, 'infrastructure/mysql.ts')]
      writeFileSync(files[0], "export { Public } from './aliases.js'")
      writeFileSync(files[1], "import { Repo } from './infrastructure/mysql.js'; const Alias = Repo; export { Alias as Public }")
      writeFileSync(files[2], 'export class Repo {}')
      const graph = buildDependencyGraph({ root, files })
      expect(graph.edges).toHaveLength(2)
      expect(graph.reexports).toHaveLength(1)
      expect(serverBoundaryFindings(graph)).toEqual([expect.objectContaining({
        rule: 'public-implementation-export', source: 'server/src/modules/a/index.ts', target: 'server/src/modules/a/infrastructure/mysql.ts',
      })])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('allows a re-exported application port and rejects malformed source', () => {
    expect(serverBoundaryFindings({ unresolved: [], edges: [], reexports: [
      { source: 'server/src/modules/a/index.ts', target: 'server/src/modules/a/application/ports.ts', kind: 'export', typeOnly: true },
    ] })).toEqual([])
    expect(() => parseLocalReexports('export const = ;', 'index.ts')).toThrow('index.ts')
  })
})
