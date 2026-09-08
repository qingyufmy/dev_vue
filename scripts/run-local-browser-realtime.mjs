import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { localAccountEnvironment } from './run-local-account-api.mjs'

assert.ok(process.argv.length === 3 && isAbsolute(process.argv[2]))
const base = parse(await readFile(new URL('../server/.env', import.meta.url)))
const local = parse(await readFile(process.argv[2]))
Object.assign(process.env, localAccountEnvironment(base, local), { V4_BROWSER_REALTIME_PORT: '3011' })
console.log('Starting local browser realtime on 127.0.0.1:3011 with loopback Redis; existing development MySQL retained')
await import('../server/dist-v4/entrypoints/browser-realtime.js')
