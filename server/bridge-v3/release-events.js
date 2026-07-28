let releaseNotifier = null

export function setBridgeReleaseNotifier(notifier) {
  releaseNotifier = typeof notifier === 'function' ? notifier : null
}

export function notifyBridgeReleaseAvailable(release) {
  if (!releaseNotifier) return 0
  try {
    return Number(releaseNotifier(release) || 0)
  } catch {
    return 0
  }
}
