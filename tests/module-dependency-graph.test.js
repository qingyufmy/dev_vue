import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDependencies, buildDependencyGraph, dependencyCycles, serverBoundaryFindings, frontendBoundaryFindings } from '../scripts/lib/module-dependency-graph.mjs'

describe('module dependency analysis', () => {
  it('parses type-only, exports, literal and computed dynamic imports but not comments', () => {
    const edges = parseDependencies(`// import x from 'ignored'
      import type { A } from './a.js'
      export * from './b.js'
      type C = import('./c.js').C
      const d = import('./d.js')
      const e = import(variable)`, 'source.ts')
    expect(edges.map(edge => edge.specifier)).toEqual(['./a.js', './b.js', './c.js', './d.js', null])
  })
  it('reads both Vue script blocks without treating template text as imports', () => {
    const source = `<template>import x from 'bad'</template>\n<script>import './a'</script>\n<script setup lang="ts">import type { B } from './b'</script>`
    expect(parseDependencies(source, 'view.vue').map(edge => [edge.specifier, edge.line])).toEqual([['./a', 2], ['./b', 3]])
  })
  it('distinguishes erased type dependencies from mixed/runtime imports and rejects malformed syntax', () => {
    const edges = parseDependencies(`import type { A } from './a'; import { type B } from './b';
      import { type C, value } from './c'; export type { D } from './d';
      import E = require('./e'); const cast = <number>42`, 'source.ts')
    expect(edges.map(edge => edge.typeOnly)).toEqual([true, true, false, true, false])
    expect(() => parseDependencies(`import {`, 'bad.ts')).toThrow('bad.ts')
  })
  it('finds module cycles even when different files do not form a source cycle', () => {
    const findings = serverBoundaryFindings({ unresolved: [], edges: [
      { source: 'server/src/modules/a/application/x.ts', target: 'server/src/modules/b/index.ts', typeOnly: true },
      { source: 'server/src/modules/b/application/y.ts', target: 'server/src/modules/a/index.ts', typeOnly: false },
    ] })
    expect(findings).toEqual([expect.objectContaining({ rule: 'module-cycle', target: 'a -> b', runtime: false })])
  })
  it('resolves .js to TypeScript, aliases and Vue and reports missing local dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurum-boundaries-'))
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src/a.ts'), `import './b.js'; import '@/view.vue'; import './missing.js'`)
      writeFileSync(join(root, 'src/b.ts'), '')
      writeFileSync(join(root, 'src/view.vue'), '<template/>')
      const graph = buildDependencyGraph({ root, files: [join(root, 'src/a.ts')], aliases: { '@/': join(root, 'src') } })
      expect(graph.edges.map(edge => edge.target)).toEqual(['src/b.ts', 'src/view.vue'])
      expect(graph.unresolved.map(edge => edge.specifier)).toEqual(['./missing.js'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('rejects internal imports and infrastructure hidden by a public barrel', () => {
    const graph = { unresolved: [], edges: [
      { source: 'server/src/modules/a/application/use.ts', target: 'server/src/modules/b/application/service.ts', kind: 'import' },
      { source: 'server/src/modules/b/index.ts', target: 'server/src/modules/b/exports.ts', kind: 'export' },
      { source: 'server/src/modules/b/exports.ts', target: 'server/src/modules/b/infrastructure/mysql.ts', kind: 'export' },
    ] }
    expect(serverBoundaryFindings(graph).map(item => item.rule).sort()).toEqual(['cross-module-internal', 'public-implementation-export'])
  })
  it('allows public ports and infrastructure implementing its own application port', () => {
    expect(serverBoundaryFindings({ unresolved: [], edges: [
      { source: 'server/src/modules/a/application/use.ts', target: 'server/src/modules/b/index.ts' },
      { source: 'server/src/modules/a/infrastructure/mysql.ts', target: 'server/src/modules/a/application/ports.ts' },
    ] })).toEqual([])
  })
  it('rejects second entry points and nested internals from consumers outside business modules', () => {
    const findings = serverBoundaryFindings({ unresolved: [], edges: [
      { source: 'server/src/transport/routes.ts', target: 'server/src/modules/a/management.ts', kind: 'import' },
      { source: 'server/src/outbox/publisher.ts', target: 'server/src/modules/a/application/ports.ts', kind: 'type-import', typeOnly: true },
      { source: 'server/src/bootstrap/setup.ts', target: 'server/src/modules/a/infrastructure/mysql.ts', kind: 'dynamic' },
    ] })
    expect(findings).toHaveLength(3)
    expect(findings.every(finding => finding.rule === 'module-entry-access')).toBe(true)
    expect(findings.find(finding => finding.kind === 'type-import').typeOnly).toBe(true)
  })
  it('allows global public port use and assembly imports without making private helpers public entries', () => {
    expect(serverBoundaryFindings({ unresolved: [], edges: [
      { source: 'server/src/transport/routes.ts', target: 'server/src/modules/a/index.ts', kind: 'import' },
      { source: 'server/src/bootstrap/setup.ts', target: 'server/src/modules/a/composition.ts', kind: 'import' },
      { source: 'server/src/entrypoints/api.ts', target: 'server/src/modules/a/composition.ts', kind: 'import' },
      { source: 'server/src/modules/a/application/use.ts', target: 'server/src/modules/a/helpers.ts', kind: 'import' },
    ] })).toEqual([])
  })
  it('rejects composition backdoors within the same module as well as global transport', () => {
    for (const source of ['server/src/modules/a/application/use.ts', 'server/src/modules/a/infrastructure/repo.ts',
      'server/src/modules/a/index.ts', 'server/src/transport/routes.ts']) {
      expect(serverBoundaryFindings({ unresolved: [], edges: [
        { source, target: 'server/src/modules/a/composition.ts', kind: 'import', typeOnly: true },
      ] })).toEqual([expect.objectContaining({ rule: 'composition-access', source })])
    }
  })
  it('rejects reverse dependencies, external domain frameworks and unauthorized composition', () => {
    const findings = serverBoundaryFindings({ unresolved: [], edges: [
      { source: 'server/src/modules/a/application/use.ts', target: 'server/src/modules/a/infrastructure/mysql.ts' },
      { source: 'server/src/modules/a/domain/model.ts', external: 'fastify' },
      { source: 'server/src/transport/routes.ts', target: 'server/src/modules/a/composition.ts' },
    ] })
    expect(findings.map(item => item.rule).sort()).toEqual(['application-reverse-dependency', 'composition-access', 'domain-dependency'])
  })
  it('reports one stable component for overlapping cycles and ignores acyclic paths', () => {
    expect(dependencyCycles([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' },
      { source: 'c', target: 'a' }, { source: 'b', target: 'a' }, { source: 'x', target: 'a' }])).toEqual([['a', 'b', 'c']])
  })
  it('detects relative cross-app and feature imports plus shared packages importing application code', () => {
    const findings = frontendBoundaryFindings({ unresolved: [], edges: [
      { source: 'frontend/apps/trade/src/features/account/view.vue', target: 'frontend/apps/admin/src/features/user/index.ts' },
      { source: 'frontend/apps/trade/src/features/account/view.vue', target: 'frontend/apps/trade/src/features/chart/model/private.ts' },
      { source: 'frontend/packages/ui/src/index.ts', target: 'frontend/apps/trade/src/features/chart/index.ts' },
    ] })
    expect(findings.map(item => item.rule).sort()).toEqual(['cross-application', 'feature-internal', 'shared-package-to-application'])
  })
  it('allows a feature own implementation and another feature public API', () => {
    expect(frontendBoundaryFindings({ unresolved: [], edges: [
      { source: 'frontend/apps/trade/src/features/account/view.vue', target: 'frontend/apps/trade/src/features/account/model/private.ts' },
      { source: 'frontend/apps/trade/src/features/account/view.vue', target: 'frontend/apps/trade/src/features/chart/index.ts' },
    ] })).toEqual([])
  })
})
