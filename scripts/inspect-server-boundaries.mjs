import ts from 'typescript'
import { resolve } from 'node:path'
import { sourceFiles, buildDependencyGraph, serverBoundaryFindings } from './lib/module-dependency-graph.mjs'

const root = resolve(import.meta.dirname, '..')
const configPath = resolve(root, 'server/tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, 'server'))
const files = sourceFiles(resolve(root, 'server/src'))
const graph = buildDependencyGraph({ root, files, compilerOptions: parsed.options })
const findings = serverBoundaryFindings(graph)
console.log(JSON.stringify({ files: files.length, edges: graph.edges.length, findings }, null, 2))
// This strict inspection never blesses existing findings as a passing baseline.
if (findings.length) process.exitCode = 1
