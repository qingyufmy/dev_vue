export function installProcessLifecycle(role: string, shutdown: () => Promise<void>) {
  let closing: Promise<void> | null = null
  const close = () => closing ??= shutdown()
  const signal = (name: string) => { void close().then(() => process.exit(0), error => fatal(role, error)) }
  process.once('SIGTERM', () => signal('SIGTERM'))
  process.once('SIGINT', () => signal('SIGINT'))
  process.once('uncaughtException', error => fatal(role, error))
  process.once('unhandledRejection', error => fatal(role, error))
  return close
}

function fatal(role: string, error: unknown): never {
  console.error(`[${role}] fatal`, error instanceof Error ? error.stack : String(error))
  process.exit(1)
}
