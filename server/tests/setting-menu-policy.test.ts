import { expect,it } from 'vitest'
import { validateSettingMenu } from '../src/modules/settings/domain/setting-menu-policy.js'
import { validateSettingValueForWrite } from '../src/modules/settings/domain/setting-value-policy.js'
const inspect=(v:unknown,tool=false)=>validateSettingValueForWrite({namespace:tool?'toolbox':'market_menu',key:'items',expectedType:'json_array',value:JSON.stringify(v)},validateSettingMenu)
const item={name:'研究',icon:'📈',url:'/research/'}
it('accepts flat menus and grouped tools while retaining known optional fields',()=>{
 expect(inspect([item])).toBe(true)
 expect(inspect([{category:'工具',items:[{...item,url:'https://example.com/path?q=1',desc:'说明',tag:'推荐',tagColor:'#abc',code:'A1',rebate:'说明',note:'备注'}]}],true)).toBe(true)
 expect(inspect([])).toBe(true)
})
it('rejects executable or ambiguous links, credentials and control characters',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','//example.com','/\\example.com','https://user:pass@example.com','https://example.com/\n',' https://example.com'])expect(inspect([{...item,url}])).toBe(false)
})
it('rejects unknown fields, invalid nested structure and CSS injection',()=>{
 for(const v of [[{...item,onClick:'x'}],[{...item,name:''}],[{...item,url:null}],[null]])expect(inspect(v)).toBe(false)
 expect(inspect([{category:'工具',items:[{...item,tagColor:'red;display:none'}]}],true)).toBe(false)
 expect(inspect([{category:'工具',items:{}}],true)).toBe(false)
})
it('bounds arrays and refuses unrelated domain checks',()=>{
 expect(inspect(Array.from({length:201},()=>item))).toBe(false)
 expect(validateSettingMenu('smtp_endpoint',{namespace:'smtp',key:'host',expectedType:'string',value:'mail.example.com'})).toBe(false)
 expect(validateSettingValueForWrite({namespace:'media_storage',key:'default_provider',expectedType:'enum',value:'qiniu'},validateSettingMenu)).toBe(false)
})
