import {expect,it} from 'vitest'
import {modelThinkingOptions} from '../src/modules/inference/infrastructure/model-thinking-options.js'
it('uses protocol-specific reasoning fields and omits depth when disabled',()=>{
 expect(modelThinkingOptions('volcengine_agent_plan','chat_completions',true,'high')).toEqual({thinking:{type:'enabled'},reasoning_effort:'high'})
 expect(modelThinkingOptions('volcengine','responses',true,'max')).toEqual({thinking:{type:'enabled'},reasoning:{effort:'max'}})
 expect(modelThinkingOptions('deepseek','chat_completions',false,'max')).toEqual({thinking:{type:'disabled'}})
 expect(modelThinkingOptions('other','chat_completions',true,'high')).toEqual({})
})
