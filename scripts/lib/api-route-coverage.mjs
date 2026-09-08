const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'])
const shape = path => path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}')
const key = operation => `${operation.method.toUpperCase()} ${shape(operation.path)}`

function dereference(document, value) {
  const seen = new Set()
  while (value?.$ref) {
    const ref = value.$ref
    if (!ref.startsWith('#/') || seen.has(ref)) throw new Error(`unsupported_or_cyclic_ref:${ref}`)
    seen.add(ref)
    value = ref.slice(2).split('/').reduce((object, token) => object?.[token.replaceAll('~1', '/').replaceAll('~0', '~')], document)
    if (!value) throw new Error(`missing_ref:${ref}`)
  }
  return value
}

export function documentedOperations(document) {
  const result = []
  for (const [path, raw] of Object.entries(document.paths ?? {})) {
    const item = dereference(document, raw)
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue
      const servers = operation.servers ?? item.servers ?? document.servers ?? [{ url: '/' }]
      if (servers.length !== 1 || servers[0].url.includes('{')) throw new Error(`ambiguous_operation_server:${method} ${path}`)
      const base = new URL(servers[0].url, 'http://contract.invalid').pathname.replace(/\/$/, '')
      result.push({ method: method.toUpperCase(), path: base + path, operationId: operation.operationId ?? null })
    }
  }
  return result
}

export function compareApiRoutes(document, routes, prefix = '/api/v4') {
  const documented = documentedOperations(document)
  const business = routes.filter(route => route.path === prefix || route.path.startsWith(prefix + '/'))
  const byKey = new Map(routes.map(route => [key(route), route]))
  const contractKeys = new Set(documented.map(key))
  const duplicates = items => [...new Set(items.filter((item, index) => items.indexOf(item) !== index))].sort()
  const missing = documented.filter(operation => !byKey.has(key(operation)))
  const undocumented = business.filter(route => !contractKeys.has(key(route)))
  const parameterNames = path => [...path.matchAll(/\{([^}]+)\}|:([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1] ?? match[2])
  const parameterNameDifferences = documented.flatMap(operation => {
    const route = byKey.get(key(operation))
    return route && JSON.stringify(parameterNames(operation.path)) !== JSON.stringify(parameterNames(route.path))
      ? [{ contract: operation, runtime: route }] : []
  })
  return {
    documentedCount: documented.length, businessRouteCount: business.length,
    matchedCount: documented.length - missing.length, missing, undocumented, parameterNameDifferences,
    duplicateContractRoutes: duplicates(documented.map(key)), duplicateRuntimeRoutes: duplicates(business.map(key)),
    missingOperationIds: documented.filter(operation => !operation.operationId),
    duplicateOperationIds: duplicates(documented.map(operation => operation.operationId).filter(Boolean)),
    outsideBusinessPrefix: routes.filter(route => !business.includes(route)),
    // Schema presence is evidence of registration, not proof of OpenAPI equivalence.
    schemaRegistration: business.map(route => ({ method: route.method, path: route.path, schemas: route.schemas ?? [] })),
  }
}
