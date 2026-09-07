import { LearningError } from './learning.js'

export interface LearningCompletionCommand {
  userId: number
  courseId: string
  lessonId: string
  requestId: string
  expectedRevision: string
  completed: boolean
}
export interface LearningCompletionResult {
  lesson_id: string
  completed: boolean
  revision: string
  updated_at: string
  replayed: boolean
}
export interface LearningCompletionRepository {
  execute(command: LearningCompletionCommand): Promise<LearningCompletionResult>
}

export function normalizeLearningCompletion(input: LearningCompletionCommand): LearningCompletionCommand {
  const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)
    && !/[^0-9]/.test(value) && BigInt(value) <= 2147483647n
  if (!input || Object.keys(input).sort().join(',') !== 'completed,courseId,expectedRevision,lessonId,requestId,userId'
    || !Number.isSafeInteger(input.userId) || input.userId < 1 || input.userId > 2147483647
    || !id(input.courseId) || !id(input.lessonId) || typeof input.completed !== 'boolean'
    || typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)
    || /[^0-9a-f-]/.test(input.requestId)
    || typeof input.expectedRevision !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(input.expectedRevision)
    || /[^0-9]/.test(input.expectedRevision) || BigInt(input.expectedRevision) >= 18446744073709551615n) {
    throw new LearningError('learning_completion_invalid', 400)
  }
  return { userId: input.userId, courseId: input.courseId, lessonId: input.lessonId, requestId: input.requestId,
    expectedRevision: input.expectedRevision, completed: input.completed }
}
