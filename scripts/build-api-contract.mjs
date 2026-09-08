import { readFile, writeFile, readdir } from 'node:fs/promises'
import { bundleApiContract, serializeApiContract } from './lib/api-contract-bundle.mjs'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('usage: build-api-contract.mjs [--check]')
const root = new URL('../contracts/http/', import.meta.url)
const read = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const base = await read('base.json')
const { domains } = await read('manifest.json')
if (!Array.isArray(domains) || domains.some(name => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error('invalid_contract_manifest')
const files = (await readdir(new URL('domains/', root))).sort()
const declared = domains.map(name => `${name}.json`).sort()
if (JSON.stringify(files) !== JSON.stringify(declared)) throw new Error('contract_manifest_file_mismatch')
const sources = await Promise.all(domains.map(async name => ({ name, document: await read(`domains/${name}.json`) })))
const output = serializeApiContract(bundleApiContract(base, sources))
const target = new URL('../contracts/openapi-v4.json', import.meta.url)
if (args.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('generated_contract_drift: run pnpm run generate:api-contract')
  console.log(`API contract generation matches ${domains.length} sources`)
} else {
  await writeFile(target, output)
  console.log(`Generated API contract from ${domains.length} sources`)
}
