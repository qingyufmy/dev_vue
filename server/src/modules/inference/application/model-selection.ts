export interface ModelChoice { id: string; name: string; scope: 'user' | 'platform'; available: boolean; reason: string | null }
export interface ModelSelection { selected_model_profile_id: string | null; items: ModelChoice[] }
export interface ModelSelectionService {
  read(userId: number): Promise<ModelSelection>
  select(userId: number, modelId: string, expectedModelId: string | null): Promise<ModelSelection>
}
