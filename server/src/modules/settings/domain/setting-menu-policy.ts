import type { SettingPolicyCheck,SettingValueInput } from './setting-value-policy.js'
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown,max:number,required=false)=>typeof v==='string'&&[...v].length<=max&&(!required||v.trim().length>0)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
function link(v:unknown):boolean {
 if(typeof v!=='string'||v.length>2048||/[\\\u0000-\u0020\u007f]/.test(v))return false
 try {
  if(v.startsWith('/')&&!v.startsWith('//'))return new URL(v,'https://setting.invalid').origin==='https://setting.invalid'
  if(!/^https?:\/\//.test(v))return false
  const url=new URL(v);return !!url.hostname&&!url.username&&!url.password
 }catch{return false}
}
function item(v:unknown,tool:boolean):boolean {
 if(!record(v))return false
 const allowed=tool?['name','icon','url','desc','tag','tagColor','code','rebate','note']:['name','icon','url']
 if(Object.keys(v).some(k=>!allowed.includes(k))||!text(v.name,200,true)||!link(v.url))return false
 for(const k of allowed.filter(k=>!['name','url','tagColor'].includes(k)))if(k in v&&!text(v[k],k==='desc'||k==='note'?4000:200))return false
 return !('tagColor'in v)||v.tagColor===''||(typeof v.tagColor==='string'&&/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(v.tagColor)&&!/[\r\n]/.test(v.tagColor))
}
// Domain semantics only. The outer value contract retains byte/length/type
// checks. Return false for unrelated policies so no other domain is bypassed.
export function validateSettingMenu(check:SettingPolicyCheck,input:Readonly<SettingValueInput>):boolean {
 if(input.key!=='items'||input.expectedType!=='json_array'||typeof input.value!=='string'||input.value.length>500000)return false
 if(!((check==='menu_items'&&input.namespace==='market_menu')||(check==='toolbox_items'&&input.namespace==='toolbox')))return false
 let value:unknown;try{value=JSON.parse(input.value)}catch{return false}
 if(!Array.isArray(value))return false
 if(check==='menu_items')return value.length<=200&&value.every(v=>item(v,false))
 if(value.length>100)return false
 let count=0
 return value.every(group=>{
  if(!record(group)||Object.keys(group).some(k=>!['category','items'].includes(k))||!text(group.category,200,true)||!Array.isArray(group.items)||group.items.length>200)return false
  count+=group.items.length
  return count<=2000&&group.items.every(v=>item(v,true))
 })
}
