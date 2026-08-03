import { beginModelTaskAttempt, claimModelTaskById, createModelTask, finishModelTaskAttempt,
  renewModelTaskLease, transitionModelTask } from './model-task-runtime.js'

function noopTracker() {
  const noop = async () => {}
  return { active:false, taskId:null, onProviderRequest:noop, onProviderUsage:noop,
    resultReady:noop, applying:noop, succeeded:noop, failed:noop, stop:noop }
}

export async function createShadowModelTaskTracker(input, { linkTask = null, workerId = null } = {}) {
  try {
    const { task:createdTask } = await createModelTask(input)
    if (!createdTask) return noopTracker()
    if (typeof linkTask === 'function') await linkTask(createdTask.task_id)
    let task = await claimModelTaskById(createdTask.task_id, { workerId:workerId || `shadow:${process.pid}` })
    if (!task) return noopTracker()
    task = await transitionModelTask(task, 'preparing')
    let attempt = null
    let providerAttemptSequence = 0
    let stopped = false
    let pending = Promise.resolve()
    const enqueue = operation => {
      pending = pending.then(operation).catch(error => {
        console.error(`[ModelTaskShadow] task=${task?.task_id || createdTask.task_id}:`, error.message)
      })
      return pending
    }
    const renewTimer = setInterval(() => enqueue(async () => {
      if (!stopped && !await renewModelTaskLease(task)) throw new Error('model_task_shadow_lease_lost')
    }), 30_000)
    renewTimer.unref?.()

    return {
      active:true,
      taskId:createdTask.task_id,
      onProviderRequest:event => enqueue(async () => {
        if (task.status === 'response_received') task = await transitionModelTask(task, 'validating')
        if (task.status === 'validating') task = await transitionModelTask(task, 'repairing')
        if (task.status === 'repairing') task = await transitionModelTask(task, 'submitted')
        if (task.status === 'preparing') task = await transitionModelTask(task, 'submitted')
        if (!attempt) attempt = await beginModelTaskAttempt(task, {
          attemptNo:(Math.max(1, Number(task.attempt_count)) - 1) * 10 + (++providerAttemptSequence),
          providerRequestId:event?.providerRequestId || null,
        })
      }),
      onProviderUsage:event => enqueue(async () => {
        if (!attempt) return
        await finishModelTaskAttempt(task, attempt, {
          status:event?.status === 'success' ? 'succeeded' : 'failed',
          providerRequestId:event?.providerRequestId, inputTokens:event?.inputTokens,
          outputTokens:event?.outputTokens, reasoningTokens:event?.reasoningTokens,
          cachedTokens:event?.cachedTokens, totalTokens:event?.totalTokens || event?.tokenCount,
          finishReason:event?.finishReason, incompleteDetails:event?.incompleteDetails,
          errorCode:event?.errorCode,
        })
        attempt = null
        if (event?.status === 'success' && task.status === 'submitted') {
          task = await transitionModelTask(task, 'response_received', {
            finishReason:event?.finishReason, incompleteDetails:event?.incompleteDetails,
          })
        }
      }),
      resultReady:patch => enqueue(async () => {
        if (task.status === 'submitted') task = await transitionModelTask(task, 'response_received')
        if (task.status === 'response_received') task = await transitionModelTask(task, 'validating')
        if (task.status === 'validating') task = await transitionModelTask(task, 'result_ready', patch)
      }),
      applying:() => enqueue(async () => {
        if (task.status === 'result_ready') task = await transitionModelTask(task, 'applying')
      }),
      succeeded:patch => enqueue(async () => {
        if (task.status === 'applying') task = await transitionModelTask(task, 'succeeded', patch)
      }),
      failed:(error, exhausted = false) => enqueue(async () => {
        const target = exhausted ? 'failed_terminal' : 'retry_wait'
        if (['leased','preparing','submitted','provider_running','provider_quiet','response_received','validating','repairing'].includes(task.status)) {
          task = await transitionModelTask(task, target, {
            errorCode:String(error?.code || error?.message || 'model_task_failed').slice(0, 128),
            errorMessage:String(error?.message || error || 'model_task_failed').slice(0, 512),
          })
        }
      }),
      async stop() {
        stopped = true
        clearInterval(renewTimer)
        await pending
      },
    }
  } catch (error) {
    console.error('[ModelTaskShadow] unable to start tracker:', error.message)
    return noopTracker()
  }
}
