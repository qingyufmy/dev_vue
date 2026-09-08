import { readFile } from 'node:fs/promises'
import { compileApiSchemas } from './lib/api-schema-compiler.mjs'

const document = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))
const { report } = compileApiSchemas(document)
console.log(JSON.stringify(report, null, 2))
if (report.failures.length) process.exitCode = 1
