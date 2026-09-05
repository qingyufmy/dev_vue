import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const contract = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))

describe('P4B observer management HTTP contract', () => {
  it('publishes the bounded admin source/channel/access/operation surface', () => {
    const paths = contract.paths
    expect(paths['/admin/observer/sources']).toEqual(expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }))
    expect(paths['/admin/observer/sources/{source_id}']).toEqual(expect.objectContaining({ put: expect.any(Object) }))
    expect(paths['/admin/observer/channels']).toEqual(expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }))
    expect(paths['/admin/observer/channels/{channel_id}']).toEqual(expect.objectContaining({ put: expect.any(Object) }))
    expect(paths['/admin/observer/channels/{channel_id}/accesses']).toEqual(expect.objectContaining({ get: expect.any(Object) }))
    expect(paths['/admin/observer/channels/{channel_id}/accesses/{user_id}']).toEqual(expect.objectContaining({ put: expect.any(Object) }))
    expect(paths['/admin/observer/default-channel']).toEqual(expect.objectContaining({ put: expect.any(Object) }))
    expect(paths['/admin/observer/operations']).toEqual(expect.objectContaining({ get: expect.any(Object) }))
  })

  it('requires strict admin-session write headers and full CAS config fields', () => {
    const putSource = contract.paths['/admin/observer/sources/{source_id}'].put
    expect(putSource.parameters.map((item) => item.$ref)).toEqual(expect.arrayContaining([
      '#/components/parameters/CsrfToken', '#/components/parameters/ObserverAdminIdempotencyKey',
    ]))
    expect(contract.components.parameters.ObserverAdminIdempotencyKey.schema).toMatchObject({ minLength: 8, maxLength: 128 })
    expect(contract.components.schemas.ObserverSourceUpdateInput).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['display_name', 'notes', 'trading_account_id', 'analysis_strategy_id', 'status', 'expected_revision']),
    })
    expect(contract.components.schemas.ObserverChannelUpdateInput).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['display_name', 'source_id', 'slug', 'description', 'audience', 'active', 'sort_order', 'expected_revision']),
    })
  })

  it('makes create defaults explicit and keeps audit secrets out of operation DTOs', () => {
    expect(contract.components.schemas.ObserverSourceCreateInput.properties.status).toMatchObject({ const: 'disabled', default: 'disabled' })
    expect(contract.components.schemas.ObserverChannelCreateInput.properties.audience).toMatchObject({ enum: ['all', 'plus', 'pro', 'assigned'], default: 'assigned' })
    expect(contract.components.schemas.ObserverChannelCreateInput.properties.active).toMatchObject({ const: false, default: false })
    expect(contract.components.schemas.ObserverOperationAdminItem.properties).not.toHaveProperty('idempotency_key')
    expect(contract.components.schemas.ObserverOperationAdminItem.properties).not.toHaveProperty('request_hash')
    expect(contract.components.schemas.ObserverOperationAdminItem.properties).toHaveProperty('audit_json')
    expect(contract.components.schemas.ObserverOperationAdminItem.required).toContain('audit_json')
  })
})
