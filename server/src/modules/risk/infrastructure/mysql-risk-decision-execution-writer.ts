import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type { RiskDecisionExecutionWriter } from '../application/risk-decision-execution-writer.js'

export function createMysqlRiskDecisionExecutionWriter(connection: Pick<PoolConnection, 'execute'>): RiskDecisionExecutionWriter {
  return {
    async linkOperation(input) {
      const [result] = await connection.execute<ResultSetHeader>(`UPDATE risk_decisions_v4
        SET operation_id=?,revision=revision+1
        WHERE id=? AND user_id=? AND trading_account_id=? AND operation_id IS NULL AND revision=?`,
      [input.operationId, input.riskDecisionId, input.userId, input.accountId, input.expectedRevision])
      return result.affectedRows === 1
    },
  }
}
