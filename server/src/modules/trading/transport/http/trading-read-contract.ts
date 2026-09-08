import { randomUUID } from 'node:crypto'
import type { FastifyReply } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { TradingAccessError } from '../../domain/trading.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export function createTradingReadContract() {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getTradingContext', 'listTradingAccounts', 'listObserverChannels'])
  return {
    ...contract,
    problem(operation: string, error: unknown, request: { id: string; url: string }, reply: FastifyReply) {
      const known = error instanceof AuthError || error instanceof TradingAccessError || error instanceof HttpContractError
        ? error : new TradingAccessError('trading_context_invalid', 503)
      const body = { type: `urn:aurum:problem:${known.code}`, title: 'Trading request failed', status: known.status,
        code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }
      try {
        return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json'))
      } catch {
        const fallback = { type: 'urn:aurum:problem:api_response_invalid', title: 'Response validation failed', status: 503,
          code: 'api_response_invalid', detail: 'api_response_invalid', instance: '/api/v4/trading-context', correlation_id: randomUUID(), retryable: true }
        return reply.type('application/problem+json').code(503).send(contract.response(operation, fallback, 503, 'application/problem+json'))
      }
    },
  }
}
