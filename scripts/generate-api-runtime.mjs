import { mkdir, readFile, writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('usage: generate-api-runtime.mjs [--check]')
const document = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))
const { operations: selected } = JSON.parse(await readFile(new URL('../contracts/http/runtime.json', import.meta.url), 'utf8'))
if (!Array.isArray(selected) || new Set(selected).size !== selected.length) throw new Error('invalid_runtime_operations')
const resolve = value => {
  const seen = new Set()
  while (value?.$ref) {
    if (seen.has(value.$ref) || !value.$ref.startsWith('#/')) throw new Error('unsupported_runtime_ref')
    seen.add(value.$ref)
    value = value.$ref.slice(2).split('/').reduce((item, key) => item?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], document)
    if (!value) throw new Error('missing_runtime_ref')
  }
  return value
}
const operations = {}
for (const item of Object.values(document.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!selected.includes(operation.operationId)) continue
    if (method !== 'get' || operation.requestBody) throw new Error('runtime_adapter_only_supports_get')
    if (operations[operation.operationId]) throw new Error('duplicate_runtime_operation')
    const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(raw => {
      const value = resolve(raw)
      if (!['path', 'query'].includes(value.in) || !value.schema || value.content) throw new Error('unsupported_runtime_parameter')
      return { name: value.name, location: value.in, required: value.required === true, integerQuery: value.in === 'query' && resolve(value.schema).type === 'integer', schema: value.schema }
    })
    const response = resolve(operation.responses?.['200'])?.content?.['application/json']?.schema
    if (!response) throw new Error('runtime_response_schema_required')
    operations[operation.operationId] = { parameters, response }
  }
}
if (Object.keys(operations).length !== selected.length) throw new Error('runtime_operation_not_found')
const schemas = {}
const collect = value => {
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (['example', 'examples', 'default', 'const', 'enum'].includes(key)) continue
    if (key === '$ref') {
      if (!entry.startsWith('#/components/schemas/')) throw new Error('unsupported_runtime_schema_ref')
      const name = entry.split('/')[3].replaceAll('~1', '/').replaceAll('~0', '~')
      if (!Object.hasOwn(schemas, name)) {
        schemas[name] = document.components.schemas[name]
        if (schemas[name] === undefined) throw new Error('missing_runtime_schema')
        collect(schemas[name])
      }
    } else collect(entry)
  }
}
collect(operations)
const data = { components: { schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }, operations }
const output = '// Generated from contracts/http. Do not edit.\nimport type { HttpRuntimeContracts } from \'../http-contract.js\'\n\nexport const httpRuntimeContracts: HttpRuntimeContracts = ' + JSON.stringify(data, null, 2) + '\n'
const directory = new URL('../server/src/transport/generated/', import.meta.url)
const target = new URL('http-contracts.ts', directory)
if (args.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('generated_api_runtime_drift')
  console.log(`Runtime contracts match ${selected.length} operations`)
} else {
  await mkdir(directory, { recursive: true })
  await writeFile(target, output)
  console.log(`Generated runtime contracts for ${selected.length} operations`)
}
