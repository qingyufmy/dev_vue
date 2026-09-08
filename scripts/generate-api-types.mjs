import { readFile, writeFile, mkdir } from 'node:fs/promises'
import openapiTS, { astToString } from 'openapi-typescript'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('usage: generate-api-types.mjs [--check]')
const document = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))
const ast = await openapiTS(document, { alphabetize: true, defaultNonNullable: false })
const output = '// Generated from contracts/http via openapi-v4.json. Do not edit.\n' + astToString(ast)
const directory = new URL('../frontend/packages/contracts/src/generated/', import.meta.url)
const target = new URL('http.ts', directory)
if (args.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('generated_api_types_drift: run pnpm run generate:api-types')
  console.log('Generated HTTP types match the API contract')
} else {
  await mkdir(directory, { recursive: true })
  await writeFile(target, output)
  console.log('Generated HTTP types')
}
