import ts from 'typescript'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, relative, dirname, extname } from 'node:path'

const slash = value => value.replaceAll('\\', '/')
const extensions = ['.ts', '.tsx', '.js', '.mjs', '.vue']
const matchesAlias = (specifier, alias) => alias.endsWith('/') ? specifier.startsWith(alias) : specifier === alias

export function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', 'dist-v4', '.nuxt', '.output', 'tests', '__tests__'].includes(entry.name)) return []
    const file = resolve(root, entry.name)
    return entry.isDirectory() ? sourceFiles(file)
      : extensions.includes(extname(file)) && !/\.(test|spec)\./.test(file) ? [file] : []
  }).sort()
}

export function parseDependencies(source, file) {
  // Vue template auto-imports require a separate generated-component inventory.
  const scripts = file.endsWith('.vue')
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => ({
      text: match[1], offset: source.slice(0, match.index + match[0].indexOf('>') + 1).split('\n').length - 1,
    })) : [{ text: source, offset: 0 }]
  return scripts.flatMap(({ text, offset }) => {
    const result = []
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    if (ast.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, '\n')}`)
    const add = (node, value, kind, typeOnly = false) => result.push({
      specifier: value && ts.isStringLiteralLike(value) ? value.text : null,
      kind, typeOnly, line: offset + ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
    })
    const visit = node => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, bindings = clause?.namedBindings
        const typeOnly = Boolean(clause?.isTypeOnly || !clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length && bindings.elements.every(element => element.isTypeOnly))
        add(node, node.moduleSpecifier, 'import', typeOnly)
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const clause = node.exportClause
        const typeOnly = Boolean(node.isTypeOnly || clause && ts.isNamedExports(clause)
          && clause.elements.length && clause.elements.every(element => element.isTypeOnly))
        add(node, node.moduleSpecifier, 'export', typeOnly)
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        add(node, node.moduleReference.expression, 'import', node.isTypeOnly)
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal, 'type-import', true)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node, node.arguments[0], 'dynamic')
      ts.forEachChild(node, visit)
    }
    visit(ast)
    return result
  })
}

export function buildDependencyGraph({ root, files, compilerOptions = {}, aliases = {} }) {
  const edges = [], unresolved = []
  for (const file of files) {
    for (const dependency of parseDependencies(readFileSync(file, 'utf8'), file)) {
      const edge = { source: slash(relative(root, file)), ...dependency }
      if (dependency.specifier === null) { unresolved.push(edge); continue }
      const specifier = dependency.specifier
      let target = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule?.resolvedFileName
      if (!target) {
        const alias = Object.keys(aliases).sort((a, b) => b.length - a.length).find(key => matchesAlias(specifier, key))
        const base = specifier.startsWith('.') ? resolve(dirname(file), specifier)
          : alias ? resolve(aliases[alias], specifier.slice(alias.length)) : null
        if (base) {
          const stem = base.replace(/\.(js|mjs)$/, '')
          target = [base, ...extensions.map(extension => stem + extension),
            ...extensions.map(extension => resolve(base, 'index' + extension))]
            .find(candidate => existsSync(candidate) && statSync(candidate).isFile())
        }
      }
      if (target && !slash(target).includes('/node_modules/')) edges.push({ ...edge, target: slash(relative(root, target)) })
      else if (specifier.startsWith('.') || Object.keys(aliases).some(key => matchesAlias(specifier, key))) unresolved.push(edge)
      else edges.push({ ...edge, external: specifier })
    }
  }
  return { edges, unresolved }
}

export function dependencyCycles(edges) {
  // Strongly connected components give stable findings even with several paths around one cycle.
  const adjacency = new Map()
  for (const { source, target } of edges) {
    if (!target) continue
    if (!adjacency.has(source)) adjacency.set(source, new Set())
    adjacency.get(source).add(target)
  }
  let next = 0
  const indexes = new Map(), low = new Map(), stack = [], active = new Set(), cycles = []
  function visit(node) {
    indexes.set(node, next); low.set(node, next++)
    stack.push(node); active.add(node)
    for (const target of adjacency.get(node) ?? []) {
      if (!indexes.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))) }
      else if (active.has(target)) low.set(node, Math.min(low.get(node), indexes.get(target)))
    }
    if (low.get(node) !== indexes.get(node)) return
    const component = []
    let member
    do { member = stack.pop(); active.delete(member); component.push(member) } while (member !== node)
    if (component.length > 1 || adjacency.get(node)?.has(node)) cycles.push(component.sort())
  }
  for (const node of adjacency.keys()) if (!indexes.has(node)) visit(node)
  return cycles.sort((a, b) => a[0].localeCompare(b[0]))
}

const moduleInfo = file => /^server\/src\/modules\/([^/]+)\/(.+)$/.exec(file ?? '')

export function moduleCycles(edges, ownerOf) {
  const projected = edges.flatMap(edge => {
    const source = ownerOf(edge.source), target = ownerOf(edge.target)
    return source && target && source !== target ? [{ ...edge, source, target }] : []
  })
  return dependencyCycles(projected).map(members => ({ members,
    runtime: dependencyCycles(projected.filter(edge => !edge.typeOnly))
      .some(cycle => cycle.every(member => members.includes(member))),
    edges: edges.filter(edge => members.includes(ownerOf(edge.source)) && members.includes(ownerOf(edge.target))
      && ownerOf(edge.source) !== ownerOf(edge.target)),
  }))
}

function cycleFindings(edges, ownerOf) {
  return [
    ...dependencyCycles(edges).map(cycle => ({ rule: 'source-cycle', source: cycle[0], target: cycle.join(' -> '),
      runtime: dependencyCycles(edges.filter(edge => !edge.typeOnly)).some(runtime => runtime.every(file => cycle.includes(file))),
    })),
    ...moduleCycles(edges, ownerOf).map(cycle => ({ rule: 'module-cycle', source: cycle.members[0],
      target: cycle.members.join(' -> '), runtime: cycle.runtime,
      evidence: cycle.edges.map(edge => ({ source: edge.source, target: edge.target, line: edge.line, typeOnly: Boolean(edge.typeOnly) })),
    })),
  ]
}

export function serverBoundaryFindings(graph) {
  const findings = []
  const add = (edge, rule) => findings.push({ rule, source: edge.source,
    target: edge.target ?? edge.external ?? edge.specifier ?? '<computed>', line: edge.line })
  for (const edge of graph.unresolved) add(edge, 'unresolved-dependency')
  for (const edge of graph.edges) {
    const source = moduleInfo(edge.source), target = moduleInfo(edge.target)
    if (source && target && source[1] !== target[1] && target[2] !== 'index.ts') add(edge, 'cross-module-internal')
    if (target?.[2] === 'composition.ts' && !/^server\/src\/(bootstrap|entrypoints)\//.test(edge.source)
      && source?.[1] !== target[1]) add(edge, 'composition-access')
    if (source?.[2].startsWith('domain/') && (edge.external
      && !edge.external.startsWith('node:') || target && (source[1] !== target[1] ? target[2] !== 'index.ts' : !target[2].startsWith('domain/')))) add(edge, 'domain-dependency')
    if (source?.[2].startsWith('application/') && target && source[1] === target[1]
      && /^(infrastructure|transport)\//.test(target[2])) add(edge, 'application-reverse-dependency')
    // Follow re-exports transitively: exporting an intermediate barrel must not hide infrastructure.
    if (source?.[2] === 'index.ts' && edge.kind === 'export') {
      const pending = [edge.target], seen = new Set()
      while (pending.length) {
        const current = pending.pop()
        if (!current || seen.has(current)) continue
        seen.add(current)
        if (/\/(infrastructure|transport)\//.test(current) || current.endsWith('/composition.ts')) {
          add({ ...edge, target: current }, 'public-implementation-export')
        }
        pending.push(...graph.edges.filter(item => item.source === current && item.kind === 'export').map(item => item.target))
      }
    }
  }
  findings.push(...cycleFindings(graph.edges, file => moduleInfo(file)?.[1]))
  return findings.sort((a, b) => `${a.source}|${a.rule}|${a.target}`.localeCompare(`${b.source}|${b.rule}|${b.target}`))
}

export function frontendBoundaryFindings(graph) {
  const findings = graph.unresolved.map(edge => ({ rule: 'unresolved-dependency', source: edge.source,
    target: edge.specifier ?? '<computed>', line: edge.line }))
  const appOf = file => /^frontend\/apps\/([^/]+)\//.exec(file ?? '')?.[1]
  const featureOf = file => /^(frontend\/apps\/[^/]+\/(?:src|app)\/features\/[^/]+)\/(.+)$/.exec(file ?? '')
  for (const edge of graph.edges) {
    const sourceApp = appOf(edge.source), targetApp = appOf(edge.target)
    const sourceFeature = featureOf(edge.source), targetFeature = featureOf(edge.target)
    const add = rule => findings.push({ rule, source: edge.source, target: edge.target, line: edge.line })
    if (sourceApp && targetApp && sourceApp !== targetApp) add('cross-application')
    if (edge.source.startsWith('frontend/packages/') && targetApp) add('shared-package-to-application')
    if (targetFeature && sourceFeature?.[1] !== targetFeature[1] && targetFeature[2] !== 'index.ts') add('feature-internal')
  }
  findings.push(...cycleFindings(graph.edges, file => featureOf(file)?.[1]))
  return findings.sort((a, b) => `${a.source}|${a.rule}|${a.target}`.localeCompare(`${b.source}|${b.rule}|${b.target}`))
}
