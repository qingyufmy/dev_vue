import { HttpContractError } from '../../../../transport/http-contract.js'

export function parseContextRevision(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new HttpContractError('api_request_invalid', 400)
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) throw new HttpContractError('api_request_invalid', 400)
  return revision
}
