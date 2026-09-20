export function providerLabel(provider?: string) {
 if(provider?.startsWith('volcengine')) return '火山方舟'
 if(provider==='deepseek') return 'DeepSeek'
 if(provider==='openai') return 'OpenAI'
 if(provider==='anthropic') return 'Anthropic'
 return provider ? '兼容接口' : '模型服务'
}
