#!/usr/bin/env node

import {
  beginAutoInferenceDeploymentDrain,
  endAutoInferenceDeploymentDrain,
  waitForAutoInferenceDeploymentDrain,
} from '../../server/routes/ai/auto-inference-deployment-drain.js'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const [command = '', ...rest] = argv
  const options = { command }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--') {
      options.commandArgs = rest.slice(index + 1)
      break
    }
    if (!value.startsWith('--')) {
      options.commandArgs = [...(options.commandArgs || []), value]
      continue
    }
    const separator = value.indexOf('=')
    if (separator > 2) {
      options[value.slice(2, separator)] = value.slice(separator + 1)
      continue
    }
    const key = value.slice(2)
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      options[key] = next
      index += 1
    } else {
      options[key] = true
    }
  }
  return options
}

function numberOption(options, key, fallback) {
  if (options[key] === undefined) return fallback
  const value = Number(options[key])
  if (!Number.isFinite(value)) throw new Error(`${key}_invalid`)
  return value
}

async function output(value) {
  const payload = `${JSON.stringify(value)}\n`
  await new Promise((resolve, reject) => {
    process.stdout.write(payload, error => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

export async function runAutoInferenceDrainCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (!['begin', 'wait', 'end'].includes(options.command)) {
    throw new Error('usage: auto-inference-drain.mjs <begin|wait|end> [options]')
  }

  if (options.command === 'begin') {
    const result = await beginAutoInferenceDeploymentDrain({
      token:options.token,
      ttlSeconds:numberOption(options, 'ttl-seconds', undefined),
    })
    if (!result.acquired) {
      await output({ ok:false, error:'auto_inference_drain_already_active', ...result })
      return 2
    }
    await output({ ok:true, command:'begin', ...result })
    return 0
  }

  const token = String(options.token || '').trim()
  if (!token) throw new Error('--token is required')
  if (options.command === 'end') {
    const result = await endAutoInferenceDeploymentDrain({ token })
    await output({ ok:result.released, command:'end', ...result })
    return result.released ? 0 : 3
  }

  const result = await waitForAutoInferenceDeploymentDrain({
    token,
    timeoutSeconds:numberOption(options, 'timeout-seconds', undefined),
    pollSeconds:numberOption(options, 'poll-seconds', 5),
    ttlSeconds:numberOption(options, 'ttl-seconds', undefined),
  })
  await output({ ok:result.drained, command:'wait', ...result })
  return result.drained ? 0 : 4
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

async function runMain() {
  try {
    const code = await runAutoInferenceDrainCli()
    process.exit(code)
  } catch (error) {
    await output({ ok:false, error:String(error?.code || error?.message || 'auto_inference_drain_failed') })
    process.exit(1)
  }
}

if (isMainModule()) {
  runMain().catch(error => {
    process.stderr.write(`${String(error?.message || error || 'auto_inference_drain_failed')}\n`, () => {
      process.exit(1)
    })
  })
}

export const __autoInferenceDrainCliTest = { parseArgs, numberOption }
