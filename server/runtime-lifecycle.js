export function listenHttpServer(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onListening = () => {
      cleanup()
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port)
  })
}

export function installFatalProcessHandlers({ processRef = process, logger = console } = {}) {
  let exiting = false
  const exit = (label, reason) => {
    if (exiting) return
    exiting = true
    const error = reason instanceof Error ? reason : new Error(String(reason || 'Unknown fatal error'))
    logger.error(`[FATAL] ${label}:`, error.message)
    if (error.stack) logger.error(error.stack)
    processRef.exit(1)
  }
  const onException = error => exit('Uncaught exception', error)
  const onRejection = reason => exit('Unhandled rejection', reason)
  processRef.on('uncaughtException', onException)
  processRef.on('unhandledRejection', onRejection)
  return () => {
    processRef.off('uncaughtException', onException)
    processRef.off('unhandledRejection', onRejection)
  }
}
