import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BRIDGE_V3_MESSAGE_TYPES } from '../server/bridge-v3/protocol.js'

const schemaDirectory = path.resolve('bridge/protocol/v3-json-schema')

describe('Bridge v3 shared JSON schema coverage', () => {
  it('keeps the envelope and one concrete schema aligned with every runtime message type', async () => {
    const envelope = JSON.parse(await readFile(path.join(schemaDirectory, 'envelope.schema.json'), 'utf8'))
    const files = (await readdir(schemaDirectory))
      .filter(name => name.endsWith('.schema.json') && name !== 'envelope.schema.json')
    const schemas = await Promise.all(files.map(async name => ({
      name,
      value:JSON.parse(await readFile(path.join(schemaDirectory, name), 'utf8')),
    })))
    const schemaTypes = new Set(schemas.map(({ value }) => value?.properties?.type?.const))
    const runtimeTypes = [...BRIDGE_V3_MESSAGE_TYPES]

    expect(new Set(envelope.properties.type.enum)).toEqual(new Set(runtimeTypes))
    expect(schemaTypes).toEqual(new Set(runtimeTypes))
    expect(envelope).not.toHaveProperty('additionalProperties')
    for (const { name, value } of schemas) {
      expect(value.allOf, name).toContainEqual({ $ref:'envelope.schema.json' })
      expect(value.unevaluatedProperties, name).toBe(false)
    }
  })

  it('keeps native client telemetry and current data actions represented', async () => {
    const read = async name => JSON.parse(await readFile(path.join(schemaDirectory, name), 'utf8'))
    const [hello, heartbeat, response, error, delta] = await Promise.all([
      read('hello.schema.json'), read('heartbeat.schema.json'), read('data-response.schema.json'),
      read('error.schema.json'), read('data-delta.schema.json'),
    ])

    expect(hello.properties).toHaveProperty('installation_id')
    expect(hello.properties).toHaveProperty('update_report')
    expect(hello.allOf).toContainEqual(expect.objectContaining({
      then:expect.objectContaining({ required:expect.arrayContaining(['installation_id']) }),
    }))
    expect(heartbeat.required).toContain('terminals')
    expect(heartbeat.properties.terminals.maxItems).toBe(32)
    expect(response.properties.action.enum).toEqual(expect.arrayContaining([
      'symbols', 'history', 'chart_data', 'pending_order_state', 'diagnostics',
    ]))
    expect(error.properties.details.type).toContain('string')
    expect(delta.required).toContain('full_snapshot')
    expect(delta.properties.upserts.maxItems).toBe(10_000)
    expect(delta.properties.deletes.maxItems).toBe(10_000)
  })
})
