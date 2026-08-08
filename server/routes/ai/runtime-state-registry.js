let autoSchedulerState = null

export function registerAutoSchedulerState(state) {
  autoSchedulerState = state
}

export function getRegisteredAutoSchedulerState() {
  return autoSchedulerState || {}
}
