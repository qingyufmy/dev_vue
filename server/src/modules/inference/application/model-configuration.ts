export interface ModelConfiguration {
  temperature?: number | null; context_window_tokens?: number | null; max_input_tokens?: number | null; max_output_tokens?: number | null
  request_timeout_ms?: number | null; thinking_enabled?: boolean; reasoning_effort?: 'low' | 'medium' | 'high' | 'max' | null

  id: string; name: string; provider: string; scope: 'user' | 'platform'; base_url: string
  protocol: 'chat_completions' | 'responses'; max_tokens: number | null; has_key: boolean
  verified: boolean; revision: string
}
export interface ModelConfigurationChange {
  provider?: 'volcengine_agent_plan' | 'deepseek' | 'openai_compatible'; scope?: 'user' | 'platform'
  temperature?: number | null; context_window_tokens?: number | null; max_input_tokens?: number | null; max_output_tokens?: number | null
  request_timeout_ms?: number | null; thinking_enabled?: boolean; reasoning_effort?: 'low' | 'medium' | 'high' | 'max' | null

  name: string; base_url: string; protocol: 'chat_completions' | 'responses'
  max_tokens?: number | null; api_key?: string; expected_revision: string
}
export interface ModelConfigurationService {
  remove(userId:number,id:string,requestId:string,revision:string):Promise<{id:string;deleted:boolean}>
  readAssignments(userId:number):Promise<{analysis:string|null;trader:string|null;review:string|null;revision:string}>
  saveAssignments(userId:number,requestId:string,change:{analysis:string|null;trader:string|null;review:string|null;revision:string}):Promise<{analysis:string|null;trader:string|null;review:string|null;revision:string}>
  verify(userId: number, id: string, requestId: string, revision: string): Promise<ModelConfiguration>
  list(userId: number): Promise<ModelConfiguration[]>
  save(userId: number, id: string, requestId: string, change: ModelConfigurationChange): Promise<ModelConfiguration>
}
