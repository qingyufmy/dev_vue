import {expect,it,vi} from 'vitest'
import type {Pool} from 'mysql2/promise'
import {shouldNotify} from '../src/modules/notifications/application/notifications.js'
import {createNotificationSettings} from '../src/modules/notifications/infrastructure/mysql-notifications.js'
import {createNotificationPublisher} from '../src/modules/notifications/infrastructure/mysql-notification-publisher.js'
import {createNotificationSourceReader} from '../src/modules/inference/infrastructure/mysql-notification-source.js'
import {createNotificationDeliveryWorker} from '../src/modules/notifications/infrastructure/delivery-worker.js'

it.each(['analysis','decision'] as const)('filters MySQL string-zero %s at the source-to-publisher boundary',async kind=>{
 const sourcePool={execute:vi.fn().mockResolvedValue([[{id:'a',user_id:7,symbol:'XAUUSD',summary:'观望',actionable:'0',created_at_utc:new Date()}]])}
 const db={beginTransaction:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn(),execute:vi.fn().mockResolvedValue([[{preferences_json:{analysis:'effective',decision:'effective'}}]])}
 const read=createNotificationSourceReader(sourcePool as unknown as Pool)
 await createNotificationPublisher({getConnection:async()=>db} as unknown as Pool,read).publish({eventType:kind==='analysis'?'market_analysis.created':'trade_decision.created',payload:{market_analysis_id:'a',decision_id:'a'}})
 expect(db.execute).toHaveBeenCalledTimes(1)
 sourcePool.execute.mockResolvedValueOnce([[{id:'b',user_id:7,symbol:'XAUUSD',summary:'机会',actionable:'1',created_at_utc:new Date()}]])
 expect((await read(kind,'b'))?.actionable).toBe(true)
})

it.each(['effective','off'])('cancels a queued non-actionable message under current %s preferences',async scope=>{
 const execute=vi.fn().mockResolvedValueOnce([[{user_id:7,message_id:'decision:a',channel:'feishu',kind:'decision',actionable:'0',preferences_json:{decision:scope,feishuEnabled:true},title:'观望',summary:'等待'}]])
   .mockResolvedValue([{affectedRows:1}])
 const send=vi.fn();vi.stubGlobal('fetch',send)
 try {
  await createNotificationDeliveryWorker({execute} as unknown as Pool).runBatch()
  expect(send).not.toHaveBeenCalled()
  expect(execute.mock.calls.at(-1)?.[1]).toEqual(['cancelled',7,'decision:a','feishu'])
 }finally{vi.unstubAllGlobals()}
})
it('filters effective messages without treating hold as an action',()=>{
 expect(shouldNotify('effective',false)).toBe(false)
 expect(shouldNotify('effective',true)).toBe(true)
 expect(shouldNotify('all',false)).toBe(true)
 expect(shouldNotify('off',true)).toBe(false)
})
it('does not expose saved channel secrets',async()=>{
 const execute=vi.fn().mockResolvedValue([[{nickname:'name',revision:2,preferences_json:{feishuWebhook:'secret-url',feishuSecret:'secret-sign'}}]])
 const result=await createNotificationSettings({execute} as unknown as Pool).read(7)
 expect(JSON.stringify(result)).not.toContain('secret-url')
 expect(JSON.stringify(result)).not.toContain('secret-sign')
 expect(result.hasFeishu).toBe(true)
 expect(execute.mock.calls[0]![1]).toEqual([7])
})
it('rejects arbitrary callback hosts before writing',async()=>{
 const pool={getConnection:vi.fn()}
 await expect(createNotificationSettings(pool as unknown as Pool).save(1,{nickname:'',revision:0,preferences:{} as any,feishuWebhook:'https://localhost/private'},'abcdefghijklmnop')).rejects.toThrow('notification_channel_invalid')
 expect(pool.getConnection).not.toHaveBeenCalled()
})
it('scopes read receipts to the requesting user and only unread messages',async()=>{
 const execute=vi.fn().mockResolvedValue([{affectedRows:0}])
 await createNotificationSettings({execute} as unknown as Pool).markRead(7,'analysis:a')
 expect(execute.mock.calls[0]![0]).toContain('user_id=? AND id=? AND read_at_utc IS NULL')
 expect(execute.mock.calls[0]![1]).toEqual([7,'analysis:a'])
})
it('suppresses effective-only hold before creating messages or delivery tasks',async()=>{
 const db={beginTransaction:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn(),execute:vi.fn().mockResolvedValue([[{preferences_json:{decision:'effective'}}]])}
 const source={userId:7,resourceId:'a',kind:'decision' as const,title:'test',summary:'hold',actionable:false,createdAt:new Date()}
 await createNotificationPublisher({getConnection:async()=>db} as unknown as Pool,async()=>source).publish({eventType:'trade_decision.created',payload:{decision_id:'a'}})
 expect(db.execute).toHaveBeenCalledTimes(1)
 expect(db.commit).toHaveBeenCalledOnce()
})

it('reads the analysis id from the producer event contract',async()=>{
 const read=vi.fn().mockResolvedValue(null)
 await createNotificationPublisher({} as Pool,read).publish({eventType:'market_analysis.created',payload:{market_analysis_id:'analysis-123',opportunity:'none'}})
 expect(read).toHaveBeenCalledWith('analysis','analysis-123')
})

it('marks every unread notification for one user without a visible-list limit', async () => {
 const execute=vi.fn().mockResolvedValue([{affectedRows:87}])
 expect(await createNotificationSettings({execute} as unknown as Pool).markAllRead(7)).toEqual({read:true})
 expect(execute.mock.calls[0]![0]).toContain('WHERE user_id=? AND read_at_utc IS NULL')
 expect(execute.mock.calls[0]![0]).not.toMatch(/LIMIT|id IN/)
 expect(execute.mock.calls[0]![1]).toEqual([7])
})
