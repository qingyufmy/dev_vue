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
    for (const { name, value } of schemas) {
      expect(value.allOf, name).toContainEqual({ $ref:'envelope.schema.json' })
      expect(value.additionalProperties, name).toBe(false)
    }
  })
})
