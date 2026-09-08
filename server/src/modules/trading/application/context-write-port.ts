import type { ContextWriteCommand, ContextWriteReceipt } from '../domain/context-write.js'

export interface ContextWritePort {
  execute(command: ContextWriteCommand): Promise<ContextWriteReceipt>
  // A receipt proves the historical command, never the user's current context.
  receipt(userId: number, requestId: string): Promise<ContextWriteReceipt | null>
}
