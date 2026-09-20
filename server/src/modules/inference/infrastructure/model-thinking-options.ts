export function modelThinkingOptions(provider: string, protocol: 'responses' | 'chat_completions', enabled?: boolean, effort?: string | null) {
 if(enabled===undefined || !(provider.startsWith('volcengine') || provider==='deepseek')) return {}
 return {thinking:{type:enabled?'enabled':'disabled'},...(enabled && effort ? protocol==='responses'?{reasoning:{effort}}:{reasoning_effort:effort}:{})}
}
