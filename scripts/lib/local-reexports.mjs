import ts from 'typescript'

// Resolve direct top-level aliases without pretending to perform full dataflow
// analysis. Synthetic exports are separate from physical dependency edges.
export function parseLocalReexports(source, file) {
  if (file.endsWith('.vue')) return []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, '\n')}`)
  const bindings = new Map(), result = []
  const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const node of ast.statements) {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause
      const bind = (name, typeOnly) => bindings.set(name.text, { specifier: node.moduleSpecifier, typeOnly })
      if (clause.name) bind(clause.name, Boolean(clause.isTypeOnly))
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) bind(named.name, Boolean(clause.isTypeOnly))
      if (named && ts.isNamedImports(named)) for (const item of named.elements) bind(item.name, Boolean(clause.isTypeOnly || item.isTypeOnly))
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      bindings.set(node.name.text, { specifier: node.moduleReference.expression, typeOnly: Boolean(node.isTypeOnly) })
    }
    if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, { alias: declaration.initializer })
      }
    }
    if (ts.isTypeAliasDeclaration(node)) bindings.set(node.name.text, { alias: node.type, typeOnly: true })
  }
  function resolve(node, seen = new Set(), typeOnly = false) {
    if (!node) return null
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return null
      const binding = bindings.get(node.text)
      if (!binding) return null
      seen.add(node.text)
      return binding.alias ? resolve(binding.alias, seen, typeOnly || Boolean(binding.typeOnly))
        : { specifier: binding.specifier, typeOnly: typeOnly || binding.typeOnly }
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node) || ts.isPropertyAccessExpression(node) || ts.isNewExpression(node)) return resolve(node.expression, seen, typeOnly)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return resolve(node.expression, seen, typeOnly)
    if (ts.isTypeReferenceNode(node)) return resolve(node.typeName, seen, true)
    if (ts.isParenthesizedTypeNode(node)) return resolve(node.type, seen, true)
    if (ts.isQualifiedName(node)) return resolve(node.left, seen, typeOnly)
    if (ts.isTypeQueryNode(node)) return resolve(node.exprName, seen, true)
    return null
  }
  function add(node, expression, typeOnly = false) {
    const resolved = resolve(expression, new Set(), typeOnly)
    if (!resolved || !resolved.specifier || !ts.isStringLiteralLike(resolved.specifier)) return
    result.push({ specifier: resolved.specifier.text, kind: 'export', typeOnly: resolved.typeOnly,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
  }
  for (const node of ast.statements) {
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const item of node.exportClause.elements) add(item, item.propertyName ?? item.name, Boolean(node.isTypeOnly || item.isTypeOnly))
    }
    if (ts.isExportAssignment(node)) add(node, node.expression)
    if (exported(node) && ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) add(declaration, declaration.initializer)
    if (exported(node) && ts.isTypeAliasDeclaration(node)) add(node, node.type, true)
  }
  return result
}
