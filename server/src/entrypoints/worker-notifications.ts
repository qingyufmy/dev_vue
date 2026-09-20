import {createNotificationDeliveryWorker} from '../modules/notifications/composition.js'
import {loadServerEnvironment,loadV4RuntimeConfig,assertV4RuntimeEnabled,createMysqlPool,AsyncPollLoop,installProcessLifecycle} from '../bootstrap/index.js'
loadServerEnvironment()
const config=loadV4RuntimeConfig()
assertV4RuntimeEnabled(config)
const pool=createMysqlPool(config.mysql),worker=createNotificationDeliveryWorker(pool)
const loop=new AsyncPollLoop(async()=>{try{await worker.runBatch()}catch{console.error('notification_delivery_unavailable')}},2000)
loop.start()
installProcessLifecycle('worker-notifications',async()=>{await loop.stop();await pool.end()})
