import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

// Source-only candidate inventory, not an SQL parser, dependency gate or retirement permit.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.argv[2]
if (!output) throw Error('usage: node scripts/inspect-account-source-dependencies.mjs <new-report.json>')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const files = []
async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
}
await walk(join(root, 'server/src'))
const candidates = [], sources = []
for (const path of files) {
  const source = await readFile(path, 'utf8')
  const file = relative(root, path).replaceAll('\\', '/')
  sources.push({ file, sha256: sha256(source) })
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  if (tree.parseDiagnostics.length) throw Error(`source_parse_failed:${file}`)
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const literal = node.getText(tree)
      // Whole template expressions include interpolated identifiers; their children
      // are not scanned twice. Concatenation/SQL helper composition remains manual.
      if (/(?:trading_accounts|trading_account_ownership\w*|trading_account_id|account_id|accountId|accountKey)/.test(literal)) {
        const sql = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|JOIN)\b/i.test(literal)
        const tableCandidates = sql ? [...literal.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z][a-z0-9_]*)/gi)].map(match => match[1]) : []
        candidates.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
          kind: sql ? 'sql-literal-candidate' : 'account-literal-candidate',
          tableCandidates: [...new Set(tableCandidates)].sort(),
          lockClause: /FOR UPDATE/i.test(literal) ? 'update' : /FOR SHARE/i.test(literal) ? 'share' : 'none-or-composed',
          excerpt: literal.replace(/\s+/g, ' ').slice(0, 320), sha256: sha256(literal) })
      }
      if (ts.isTemplateExpression(node)) return
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}
const report = {
  kind: 'account-source-dependency-candidates/v1',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'server/src/**/*.ts; source-only; no database or Redis access',
  limitations: ['Literal candidates are not a complete dependency graph or SQL ownership verdict.',
    'Dynamic SQL, concatenated helpers, JSON property-only references and external/legacy consumers require manual review.',
    'JOIN order is not physical row-lock order; lock clauses do not prove transaction ordering.',
    'Counts do not prove absence of active references or authorize deletion/retirement.'],
  scannedFiles: sources.length, candidateCount: candidates.length, sources, candidates,
}
await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ scannedFiles: sources.length, candidateCount: candidates.length,
  candidateFiles: new Set(candidates.map(item => item.file)).size }))
