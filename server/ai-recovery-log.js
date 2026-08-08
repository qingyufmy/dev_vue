// Deduplicate periodic auto-inference recovery warnings without hiding
// transitions into a terminal recovery outcome.

export function createAutoInferenceRecoveryLogDeduper() {
  let previous = { unknown:false, count:0 }

  return {
    shouldLog(result = {}) {
      const statusUnknownCount = Math.max(0, Number(result.statusUnknown) || 0)
      const terminalRecovery = (Number(result.succeeded) || 0) > 0
        || (Number(result.stale) || 0) > 0
      const statusUnknown = statusUnknownCount > 0
      const stateChanged = statusUnknown !== previous.unknown
        || (statusUnknown && statusUnknownCount !== previous.count)

      previous = { unknown:statusUnknown, count:statusUnknownCount }
      return stateChanged || terminalRecovery
    },

    reset() {
      previous = { unknown:false, count:0 }
    },
  }
}

