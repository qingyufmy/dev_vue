function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}

export function serializeApiContract(document) {
  return JSON.stringify(sorted(document), null, 2) + '\n'
}

export function bundleApiContract(base, domains) {
  if ('paths' in base || 'components' in base) throw new Error('base_cannot_own_business_contracts')
  const paths = Object.create(null)
  const components = Object.create(null)
  const owners = new Map()
  const names = new Set()
  const put = (target, key, value, location, owner) => {
    if (Object.hasOwn(target, key)) throw new Error(`duplicate_contract:${location}:${owners.get(location)}:${owner}`)
    target[key] = value
    owners.set(location, owner)
  }
  for (const { name, document } of domains) {
    if (names.has(name)) throw new Error(`duplicate_domain:${name}`)
    names.add(name)
    for (const key of Object.keys(document)) if (!['paths', 'components'].includes(key)) throw new Error(`unsupported_domain_field:${name}:${key}`)
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      if (name === 'common') throw new Error('common_cannot_own_routes')
      put(paths, path, item, `paths/${path}`, name)
    }
    for (const [group, values] of Object.entries(document.components ?? {})) {
      components[group] ??= Object.create(null)
      for (const [key, value] of Object.entries(values)) put(components[group], key, value, `components/${group}/${key}`, name)
    }
  }
  const result = { ...base, paths, components }
  const visit = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      // These values are instances, not references in the contract document.
      if (['example', 'examples', 'default', 'const', 'enum'].includes(key) || key.startsWith('x-')) continue
      if (key === '$ref') {
        if (typeof entry !== 'string' || !entry.startsWith('#/')) throw new Error(`unsupported_contract_ref:${entry}`)
        const target = entry.slice(2).split('/').reduce((node, token) => node?.[token.replaceAll('~1', '/').replaceAll('~0', '~')], result)
        if (target === undefined) throw new Error(`missing_contract_ref:${entry}`)
      } else visit(entry)
    }
  }
  visit(result)
  return sorted(result)
}
