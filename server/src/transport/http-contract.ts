import { Ajv2020 } from 'ajv/dist/2020.js'
import { createRequire } from 'node:module'
import type { ValidateFunction } from 'ajv'

interface HttpParameterContract {
  name: string
  location: 'path' | 'query'
  required: boolean
  integerQuery: boolean
  schema: Record<string, unknown>
}
export interface HttpRuntimeContracts {
  components: { schemas: Record<string, unknown> }
  operations: Record<string, { parameters: HttpParameterContract[]; response: Record<string, unknown> }>
}
export class HttpContractError extends Error {
  constructor(readonly code: 'api_request_invalid' | 'api_response_invalid', readonly status: 400 | 503) { super(code) }
}

export function createHttpContractValidator(contracts: HttpRuntimeContracts) {
  const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictRequired: false, coerceTypes: false, removeAdditional: false, useDefaults: false })
  const addFormats = createRequire(import.meta.url)('ajv-formats') as (validator: Ajv2020) => void
  addFormats(ajv)
  ajv.addKeyword('components')
  const compiled = new Map<string, { parameters: (HttpParameterContract & { validate: ValidateFunction })[]; response: ValidateFunction }>()
  for (const [id, operation] of Object.entries(contracts.operations)) {
    compiled.set(id, {
      parameters: operation.parameters.map(parameter => ({ ...parameter, validate: ajv.compile({ ...parameter.schema, components: contracts.components }) })),
      response: ajv.compile({ ...operation.response, components: contracts.components }),
    })
  }
  const operation = (id: string) => {
    const value = compiled.get(id)
    if (!value) throw new Error(`http_contract_not_registered:${id}`)
    return value
  }
  return {
    request(id: string, request: { params?: unknown; query?: unknown }) {
      for (const parameter of operation(id).parameters) {
        const source = parameter.location === 'path' ? request.params : request.query
        let value = source && typeof source === 'object' ? (source as Record<string, unknown>)[parameter.name] : undefined
        if (value === undefined && !parameter.required) continue
        if (parameter.integerQuery && typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
          const parsed = Number(value)
          if (Number.isSafeInteger(parsed)) value = parsed
        }
        if (!parameter.validate(value)) throw new HttpContractError('api_request_invalid', 400)
      }
    },
    response<T>(id: string, value: T): T {
      if (!operation(id).response(value)) throw new HttpContractError('api_response_invalid', 503)
      return value
    },
  }
}
