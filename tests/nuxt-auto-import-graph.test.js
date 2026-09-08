import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { implicitVueDependencies, implicitScriptDependencies, loadVueCompiler } from '../scripts/lib/nuxt-auto-import-graph.mjs'

const compiler = loadVueCompiler(resolve('frontend/apps/www'))
const registry = { imports: new Map([['useAccount', 'features/account/index.ts']]),
  components: new Map([['AccountCard', 'features/account/components/Card.vue'], ['account-card', 'features/account/components/Card.vue']]) }

describe('Nuxt implicit dependency graph', () => {
  it('includes auto components and composables used only in templates', () => {
    const edges = implicitVueDependencies('<template><AccountCard />{{ useAccount() }}</template>', 'page.vue', registry, compiler)
    expect(edges.map(edge => edge.kind).sort()).toEqual(['nuxt-auto-component', 'nuxt-auto-import'])
  })
  it('includes a free composable in script but respects an explicit imported binding', () => {
    expect(implicitScriptDependencies('const account = useAccount()', registry)).toHaveLength(1)
    expect(implicitScriptDependencies("import { useAccount } from './local'; useAccount()", registry)).toEqual([])
    expect(implicitScriptDependencies('const object = { useAccount }', registry)).toHaveLength(1)
  })
  it('respects shadowed function parameters without hiding a free use elsewhere', () => {
    expect(implicitScriptDependencies('function f(useAccount) { return useAccount() }', registry)).toEqual([])
    expect(implicitScriptDependencies('function f(useAccount) { return useAccount() }; useAccount()', registry)).toHaveLength(1)
  })
  it('does not treat explicitly imported components or property names as auto imports', () => {
    expect(implicitVueDependencies(`<script setup>import AccountCard from './Card.vue'</script><template><account-card /></template>`, 'page.vue', registry, compiler)).toEqual([])
    expect(implicitScriptDependencies('object.useAccount(); const obj = { useAccount: 1 }', registry)).toEqual([])
  })
})
