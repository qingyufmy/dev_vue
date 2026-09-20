import type { FastifyPluginAsync } from 'fastify'
import type { PoolConnection } from 'mysql2/promise'
import type { WalletAddressReader } from './application/wallet-address-reader.js'
import { listWalletAddresses } from './infrastructure/mysql-wallet-address-reader.js'
import { referralRuleRoutes, type ReferralRuleRoutesOptions } from './transport/http/referral-rule-routes.js'

export { MysqlLearningMembershipReader } from './infrastructure/mysql-learning-membership-reader.js'
export { MysqlReferralRuleManagement } from './infrastructure/mysql-referral-rule-management.js'

export function createWalletAddressReader(connection: Pick<PoolConnection, 'execute'>): WalletAddressReader {
  return { list: input => listWalletAddresses(connection, input) }
}

export function createReferralRuleHttp(service: ReferralRuleRoutesOptions['service'], auth: ReferralRuleRoutesOptions['auth']): FastifyPluginAsync {
  return async app => { await app.register(referralRuleRoutes, { prefix: '/api/v4/admin/referrals', service, auth }) }
}
