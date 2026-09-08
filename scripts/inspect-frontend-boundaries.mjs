import ts from 'typescript'
import { resolve } from 'node:path'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { sourceFiles, buildDependencyGraph, frontendBoundaryFindings } from './lib/module-dependency-graph.mjs'

const root = resolve(import.meta.dirname, '..')
const packagesRoot = resolve(root, 'frontend/packages')
const aliases = {}
for (const name of readdirSync(packagesRoot)) {
  const packageRoot = resolve(packagesRoot, name)
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target === 'string' && !subpath.includes('*')) aliases[manifest.name + subpath.slice(1)] = resolve(packageRoot, target)
  }
}
const graph = { edges: [], unresolved: [] }, configErrors = []
let count = 0
for (const category of ['apps', 'packages']) {
  for (const name of readdirSync(resolve(root, 'frontend', category))) {
    const projectRoot = resolve(root, 'frontend', category, name)
    const configPath = resolve(projectRoot, 'tsconfig.json')
    let compilerOptions = {}, localAliases = { ...aliases }
    if (existsSync(configPath)) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile)
      if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot)
      configErrors.push(...parsed.errors.filter(error => error.code !== 18003).map(error => ({
        project: `${category}/${name}`, message: ts.flattenDiagnosticMessageText(error.messageText, '\n'),
      })))
      compilerOptions = parsed.options
      for (const [alias, paths] of Object.entries(compilerOptions.paths ?? {})) {
        if (paths.length === 1 && alias.endsWith('/*')) localAliases[alias.slice(0, -1)] = resolve(
          compilerOptions.pathsBasePath ?? compilerOptions.baseUrl ?? projectRoot, paths[0].replace(/\*$/, ''),
        )
      }
    }
    const files = sourceFiles(projectRoot)
    count += files.length
    const result = buildDependencyGraph({ root, files, compilerOptions, aliases: localAliases })
    graph.edges.push(...result.edges); graph.unresolved.push(...result.unresolved)
  }
}
const findings = frontendBoundaryFindings(graph)
console.log(JSON.stringify({ files: count, edges: graph.edges.length, configErrors, findings,
  limitation: 'Explicit script imports only; Vue/Nuxt template auto-import ownership is not yet checked.' }, null, 2))
if (findings.length || configErrors.length) process.exitCode = 1
