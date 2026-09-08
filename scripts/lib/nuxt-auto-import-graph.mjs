import ts from 'typescript'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createRequire } from 'node:module'

const slash = value => value.replaceAll('\\', '/')

export function nuxtAutoImportRegistry({ root, projectRoot }) {
  const generatedRoot = resolve(projectRoot, '.nuxt')
  const imports = new Map(), components = new Map()
  const local = specifier => {
    if (!specifier.startsWith('.')) return null
    const base = resolve(generatedRoot, specifier)
    if (slash(base).includes('/node_modules/')) return null
    const target = [base, base + '.ts', base + '.js', base + '.mjs', base + '.vue', resolve(base, 'index.ts')].find(candidate => existsSync(candidate))
    if (!target) throw new Error(`nuxt_auto_import_target_missing:${specifier}`)
    return slash(relative(root, target))
  }
  // Generated declarations are required: missing preparation must fail, not silently drop dependencies.
  const importSource = ts.createSourceFile('imports.d.ts', readFileSync(resolve(generatedRoot, 'imports.d.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  for (const node of importSource.statements) {
    if (!ts.isExportDeclaration(node) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)
      || !node.exportClause || !ts.isNamedExports(node.exportClause)) continue
    const target = local(node.moduleSpecifier.text)
    if (target) for (const item of node.exportClause.elements) imports.set(item.name.text, target)
  }
  const componentSource = ts.createSourceFile('components.d.ts', readFileSync(resolve(generatedRoot, 'components.d.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  for (const node of componentSource.statements) {
    if (!ts.isVariableStatement(node)) continue
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      const visit = child => {
        if (ts.isImportTypeNode(child) && ts.isLiteralTypeNode(child.argument) && ts.isStringLiteral(child.argument.literal)) {
          const target = local(child.argument.literal.text)
          if (target) {
            components.set(name, target)
            components.set(name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), target)
          }
        }
        ts.forEachChild(child, visit)
      }
      visit(declaration)
    }
  }
  return { imports, components }
}

function scriptReferences(source, candidates) {
  const filename = '/__boundary_input.ts'
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const host = ts.createCompilerHost({ noLib: true, noResolve: true })
  host.getSourceFile = name => name === filename ? ast : undefined
  host.fileExists = name => name === filename
  const program = ts.createProgram([filename], { noLib: true, noResolve: true }, host)
  const checker = program.getTypeChecker(), used = new Set()
  const visit = node => {
    if (ts.isIdentifier(node) && candidates.has(node.text)) {
      const parent = node.parent
      const isProperty = ts.isPropertyAccessExpression(parent) && parent.name === node
        || (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node
      if (!isProperty) {
        const symbol = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node)
        if (!symbol) used.add(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  // Top-level names are needed to exclude explicit imports from compiled template lookups.
  const topLevel = new Set()
  for (const symbol of checker.getSymbolsInScope(ast, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) topLevel.add(symbol.name)
  return { used, topLevel }
}

export function implicitVueDependencies(source, file, registry, compiler) {
  const { descriptor, errors } = compiler.parse(source, { filename: file })
  if (errors.length) throw new Error(`${file}: ${String(errors[0])}`)
  const script = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n')
  const candidates = new Set([...registry.imports.keys(), ...registry.components.keys()])
  const { used, topLevel } = scriptReferences(script, candidates)
  const result = [...used].filter(name => registry.imports.has(name)).map(name => ({ name, target: registry.imports.get(name), kind: 'nuxt-auto-import' }))
  if (descriptor.template) {
    const compiled = compiler.compileTemplate({ source: descriptor.template.content, filename: file, id: 'boundary' })
    if (compiled.errors.length) throw new Error(`${file}: ${String(compiled.errors[0])}`)
    const ast = ts.createSourceFile(file + '.template.ts', compiled.code, ts.ScriptTarget.Latest, true)
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '_resolveComponent'
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const name = node.arguments[0].text
        const normalized = name.replace(/(^|-)(\w)/g, (_match, _prefix, letter) => letter.toUpperCase())
        if (!topLevel.has(name) && !topLevel.has(normalized) && registry.components.has(name)) result.push({ name, target: registry.components.get(name), kind: 'nuxt-auto-component' })
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '_ctx') {
        const name = node.name.text
        if (!topLevel.has(name) && registry.imports.has(name)) result.push({ name, target: registry.imports.get(name), kind: 'nuxt-auto-import' })
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return [...new Map(result.map(item => [`${item.kind}:${item.name}`, item])).values()]
}

export function loadVueCompiler(projectRoot) {
  return createRequire(resolve(projectRoot, 'package.json'))('vue/compiler-sfc')
}

export function implicitScriptDependencies(source, registry) {
  return [...scriptReferences(source, new Set(registry.imports.keys())).used]
    .map(name => ({ name, target: registry.imports.get(name), kind: 'nuxt-auto-import' }))
}
