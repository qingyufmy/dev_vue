export class InferenceError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly retryAfterMs?: number) {
    super(code)
  }
}
