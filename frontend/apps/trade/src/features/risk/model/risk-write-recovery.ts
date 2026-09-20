type ReleaseScope = { userId: string; accountId: string }
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function createRiskWriteRecovery<Request, Input>(deps: {
  read: (scope: ReleaseScope) => Request | null
  parse: (value: unknown) => Request
  create: (scope: ReleaseScope, input: Input, key: string) => Request
  storageKey: (scope: ReleaseScope) => string
  scopeError: string
  storageError: string
  storage: StoragePort
  key: () => string
  lock: <T>(name: string, work: () => Promise<T>) => Promise<T>
  current: (scope: ReleaseScope) => boolean
  query: (request: Request) => Promise<'confirmed' | 'unconfirmed'>
  send: (request: Request) => Promise<void>
  knownPreWriteRejection?: (error: unknown) => boolean
}) {
  const storageKey = deps.storageKey
  const assertCurrent = (scope: ReleaseScope) => { if (!deps.current(scope)) throw Error(deps.scopeError) }
  return {
    read: (scope: ReleaseScope) => deps.read(scope),
    async run(scope: ReleaseScope, action: 'create' | 'query' | 'retry', input?: Input) {
      return deps.lock(storageKey(scope), async () => {
        assertCurrent(scope)
        let request = deps.read(scope)
        const previouslyPending = request !== null
        if (request) {
          const result = await deps.query(request)
          assertCurrent(scope)
          if (result === 'confirmed') {
            deps.storage.removeItem(storageKey(scope))
            return 'confirmed' as const
          }
          // A second submit cannot replace the stored command with edited input.
          if (action !== 'retry') return 'unconfirmed' as const
        } else {
          if (action !== 'create' || !input) return 'absent' as const
          request = deps.parse(deps.create(scope, input, deps.key()))
          deps.storage.setItem(storageKey(scope), JSON.stringify(request))
          if (JSON.stringify(deps.read(scope)) !== JSON.stringify(request)) throw Error(deps.storageError)
        }
        assertCurrent(scope)
        try { await deps.send(request) }
        catch (error) {
          assertCurrent(scope)
          if (!previouslyPending && deps.knownPreWriteRejection?.(error)) {
            deps.storage.removeItem(storageKey(scope))
            return 'rejected' as const
          }
          throw error
        }
        assertCurrent(scope)
        // Unknown requests survive every failure, including response validation
        // and storage removal. Recovery always rechecks the exact server receipt.
        deps.storage.removeItem(storageKey(scope))
        return 'confirmed' as const
      })
    },
  }
}
