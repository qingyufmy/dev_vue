import { randomUUID } from 'node:crypto'
import type { FastifyReply } from 'fastify'
import type { createHttpContractValidator } from '../../../../transport/http-contract.js'

export function settingHttpFailure(reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>,
  operation: 'readAdminSystemSetting' | 'updateSystemSetting', body: {
    type: string; title: string; status: number; code: string; detail: string
    instance: string; correlation_id: string; retryable: boolean
  }) {
  try {
    return reply.type('application/problem+json').code(body.status)
      .send(contract.response(operation, body, body.status, 'application/problem+json'))
  } catch {
    const code = operation === 'updateSystemSetting' ? 'setting_commit_unknown' : 'setting_read_unavailable'
    const fallback = { type: `urn:aurum:problem:${code}`, title: '配置请求结果暂不可用', status: 503, code,
      detail: operation === 'updateSystemSetting' ? '暂时无法确认结果，请保留原请求编号和内容。' : '配置暂不可用，请稍后重试。',
      instance: '/api/v4/admin/settings/value', correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503)
      .send(contract.response(operation, fallback, 503, 'application/problem+json'))
  }
}
