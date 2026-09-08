import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const escape = value => value.replaceAll('~', '~0').replaceAll('/', '~1')

// Enumerates schema positions, not examples or arbitrary instance properties.
export function apiSchemas(document) {
  if (document.openapi !== '3.1.0') throw new Error('unsupported_openapi_dialect')
  const schemas = new Map()
  const resolve = input => {
    let value = input
    const seen = new Set()
    while (value?.$ref) {
      const ref = value.$ref
      if (!ref.startsWith('#/') || seen.has(ref)) throw new Error(`unsupported_or_cyclic_ref:${ref}`)
      seen.add(ref)
      value = ref.slice(2).split('/').reduce((item, key) => item?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], document)
      if (!value) throw new Error(`missing_ref:${ref}`)
    }
    return value
  }
  const content = (value, path) => {
    for (const [media, entry] of Object.entries(value ?? {})) {
      if (entry.schema !== undefined) schemas.set(`${path}/${escape(media)}/schema`, entry.schema)
    }
  }
  const parameter = (value, path) => {
    value = resolve(value)
    if (value.schema !== undefined) schemas.set(`${path}/schema`, value.schema)
    content(value.content, `${path}/content`)
  }
  const response = (value, path) => {
    value = resolve(value)
    content(value.content, `${path}/content`)
    for (const [name, header] of Object.entries(value.headers ?? {})) parameter(header, `${path}/headers/${escape(name)}`)
  }
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) schemas.set(`#/components/schemas/${escape(name)}`, schema)
  for (const group of ['parameters', 'headers', 'requestBodies', 'responses']) {
    for (const [name, value] of Object.entries(document.components?.[group] ?? {})) {
      const path = `#/components/${group}/${escape(name)}`
      if (group === 'responses') response(value, path)
      else parameter(value, path)
    }
  }
  const paths = (items, root) => {
    for (const [name, rawItem] of Object.entries(items ?? {})) {
      const item = resolve(rawItem)
      const path = `${root}/${escape(name)}`
      item.parameters?.forEach((entry, index) => parameter(entry, `${path}/parameters/${index}`))
      for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
        const operation = item[method]
        if (!operation) continue
        const base = `${path}/${method}`
        operation.parameters?.forEach((entry, index) => parameter(entry, `${base}/parameters/${index}`))
        content(resolve(operation.requestBody)?.content, `${base}/requestBody/content`)
        for (const [status, value] of Object.entries(operation.responses ?? {})) response(value, `${base}/responses/${escape(status)}`)
        if (operation.callbacks) throw new Error(`unsupported_callbacks:${base}`)
      }
    }
  }
  paths(document.paths, '#/paths')
  paths(document.webhooks, '#/webhooks')
  paths(document.components?.pathItems, '#/components/pathItems')
  if (document.components?.callbacks) throw new Error('unsupported_component_callbacks')
  return schemas
}

export function compileApiSchemas(document) {
  const schemas = apiSchemas(document)
  const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictRequired: false, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
  addFormats(ajv)
  // OpenAPI discriminator is an annotation; oneOf remains the validation rule.
  ajv.addKeyword('discriminator')
  ajv.addKeyword('components')
  const validators = new Map()
  const failures = []
  for (const [location, schema] of schemas) {
    try {
      validators.set(location, ajv.compile(typeof schema === 'boolean' ? schema : { ...schema, components: document.components }))
    } catch (error) {
      failures.push({ location, error: error.message })
    }
  }
  return { validators, report: { dialect: 'JSON Schema 2020-12', schemaCount: schemas.size, compiledCount: validators.size, failures, scope: 'Schema compilation only; not OpenAPI structural, route, producer/consumer or business acceptance.' } }
}
