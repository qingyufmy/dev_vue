import { normalizeLearningCompletion, type LearningCompletionCommand, type LearningCompletionRepository } from '../domain/learning-completion.js'

export class LearningCompletionService {
  constructor(private readonly repository: LearningCompletionRepository) {}
  save(command: LearningCompletionCommand) {
    return this.repository.execute(normalizeLearningCompletion(command))
  }
}
