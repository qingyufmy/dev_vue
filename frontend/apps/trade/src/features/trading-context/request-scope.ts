/** Each caller supplies its user/account lifetime key; channels keep unrelated reads independent. */
export function createRequestScope(readScope: () => string) {
  const revisions = new Map<string, number>()
  function invalidate(channel: string) { revisions.set(channel, (revisions.get(channel) ?? 0) + 1) }
  return {
    invalidate,
    begin(channel: string) {
      invalidate(channel)
      const revision = revisions.get(channel), scope = readScope()
      return () => revisions.get(channel) === revision && readScope() === scope
    },
  }
}
