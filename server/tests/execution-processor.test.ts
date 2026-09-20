import { expect, it, vi } from 'vitest'
import { createExecutionProcessor } from '../src/queue/execution-processor.js'

function fixture() {
  const planning = { prepare: vi.fn() }, preparation = { run: vi.fn() }, distributionTargets = { run: vi.fn() }
  return { planning, preparation, distributionTargets, process: createExecutionProcessor({ planning, preparation, distributionTargets }) }
}

it('rejects unknown job names even when an intent ID is present', async () => {
  const fixtureValue = fixture()
  await expect(fixtureValue.process({ name: 'unregistered.command', data: { intentId: 'intent-1' } })).rejects.toThrow('execution_job_invalid')
  expect(fixtureValue.preparation.run).not.toHaveBeenCalled()
})

it.each([null, [], { userId: 7, riskDecisionId: '' }, { userId: 7, riskDecisionId: 123 }, { userId: '7', riskDecisionId: 'risk-1' }])(
  'rejects malformed queue payload before any business call: %j', async data => {
    const fixtureValue = fixture()
    await expect(fixtureValue.process({ name: 'execution.risk-decision.prepare', data })).rejects.toThrow()
    expect(fixtureValue.planning.prepare).not.toHaveBeenCalled()
  },
)

it('dispatches approved-risk tasks to the planning port with stable identity', async () => {
  const fixtureValue = fixture()
  fixtureValue.planning.prepare.mockResolvedValue({ kind: 'prepared' })
  expect(await fixtureValue.process({ name: 'execution.risk-decision.prepare', data: { userId: 7, riskDecisionId: 'risk-1' } }))
    .toEqual({ riskDecisionId: 'risk-1', kind: 'prepared' })
  expect(fixtureValue.planning.prepare).toHaveBeenCalledWith(7, 'risk-1')
})

it('keeps busy preparation retryable and does not hide dependency failures', async () => {
  const fixtureValue = fixture()
  fixtureValue.preparation.run.mockResolvedValueOnce({ kind: 'busy' }).mockRejectedValueOnce(Error('storage_unavailable'))
  const job = { name: 'execution.intent.prepare', data: { intentId: 'intent-1' } }
  await expect(fixtureValue.process(job)).rejects.toThrow('execution_prepare_busy')
  await expect(fixtureValue.process(job)).rejects.toThrow('storage_unavailable')
})


it('delays busy preparation with its lock token instead of consuming a failed attempt', async () => {
  const value = fixture()
  value.preparation.run.mockResolvedValue({ kind: 'busy', accountId: '7' })
  const moveToDelayed = vi.fn(async () => undefined)
  await expect(value.process({ name: 'execution.intent.prepare', data: { intentId: 'intent-1' }, moveToDelayed }, 'lock-token'))
    .rejects.toThrow('bullmq:movedToDelayed')
  expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token')
})
