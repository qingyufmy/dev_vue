import { Router } from 'express'
import { queryAll, queryOne } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { translateAdminProfileError, updateAdminUserProfile } from '../admin/user-profile.js'
import { anonymizeAdminUser } from '../admin/user-deletion.js'
import { getAdminAiOperationsOverview } from '../admin/ai-operations.js'
import { updateObserverChannel, updateObserverSource } from './ai/observer-channels.js'
import { createObserverChannel, createObserverSource, deleteObserverChannel, deleteObserverSource, listObserverChannelAssignments, replaceObserverChannelAssignments } from './ai/observer-channels.js'
import { reconcileAutoSchedulers } from './ai/scheduler.js'
import { isBridgeAlive, broadcastAdminEvent } from '../bridge-ws.js'
import { createObserverSourceAccount } from './ai/observer-source-accounts.js'
import { synchronizeObserverSourceRuntime } from './ai/observer-source-runtime.js'
import { getAdminPlatformRiskPolicy, getAdminRiskAuditOverview, listAdminAuditEvents, saveAdminPlatformRiskPolicy } from '../admin/risk-audit.js'
import { setGlobalKillSwitch } from './ai/risk-state.js'
import { deleteAdminCourse, getAdminContentSystemOverview, getAdminCourse, listAdminCourses, listAdminFeedback, saveAdminCourse } from '../admin/content-system.js'
import { getUserModelProfiles } from './ai/model-profiles.js'
import { listStrategies, getStrategyById, createStrategy, updateStrategy, getStrategyDeletionPreview, deleteStrategy } from './ai/strategy-ownership.js'
import { listModelSnapshotSamples } from './ai/model-snapshot-samples.js'
import { deleteHistoryCompareJob, getHistoryCompareJob, listHistoryCompareJobs, startHistoryCompareJob } from './ai/strategy.js'

const router = Router()

function integer(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function serializeUser(row) {
  const expired = Boolean(Number(row.membership_expired || 0))
  return {
    id:Number(row.id),
    uid:row.uid || `WS${String(row.id).padStart(6, '0')}`,
    email:row.email || '',
    phone:row.phone || '',
    nickname:row.nickname || '',
    avatar:row.avatar || '',
    role:row.role || 'user',
    plan:row.plan || 'free',
    plan_source:row.plan_source || null,
    plan_expires_at:row.plan_expires_at || null,
    membership_expired:expired,
    membership_status:row.plan === 'free' ? 'free' : expired ? 'expired' : 'active',
    created_at:row.created_at || null,
    last_seen_at:row.last_seen_at || null,
    bridge_connected:Boolean(Number(row.bridge_connected || 0)),
    mt5_account_count:Number(row.mt5_account_count || 0),
    strategy_count:Number(row.strategy_count || 0),
  }
}

const ORDER_STATUSES = new Set(['pending', 'processing', 'paid', 'expired', 'failed', 'cancelled'])

function serializeOrder(row) {
  return {
    id:Number(row.id),
    order_id:row.order_id || row.order_no,
    order_no:row.order_no || '',
    user_id:Number(row.user_id),
    user_uid:row.user_uid || '',
    user_name:row.user_name || '',
    user_email:row.user_email || '',
    plan:row.plan || '',
    plan_label:row.plan_label || '',
    period:row.period || '',
    period_label:row.period_label || '',
    amount:Number(row.amount || 0),
    confirmed_amount:Number(row.amount_confirmed || 0),
    currency:row.currency || 'USD',
    status:row.status || 'pending',
    status_label:row.status_label || '',
    payment_method:row.payment_method || '',
    paid_at:row.paid_at || null,
    created_at:row.created_at || null,
  }
}

const AI_OPERATION_ERRORS = {
  observer_source_not_found:'观摩源不存在',
  observer_channel_not_found:'观摩频道不存在',
  observer_source_strategy_invalid:'观摩源绑定的策略不可用',
  observer_source_strategy_in_use:'该策略已被其他观摩源使用',
  bridge_user_not_found:'观摩源桥接账号不存在',
  bridge_user_requires_pro:'观摩源账号必须是有效 Pro 用户或管理员',
  trading_account_not_owned_by_source:'所选 MT5 账户不属于该观摩源账号',
  observer_source_has_channels:'该观摩源仍绑定频道，请先调整或删除频道',
  observer_source_email_invalid:'请输入有效的桥接源登录邮箱',
  observer_source_email_exists:'该邮箱已被其他账号使用',
  observer_source_password_invalid:'密码需为 8 至 128 位，并同时包含字母和数字',
  default_observer_channel_cannot_be_deleted:'默认观摩频道不能删除，请先设置其他默认频道',
  invalid_channel_audience:'频道开放范围无效',
  source_name_required:'请填写观摩源名称',
  channel_name_required:'请填写频道名称',
  invalid_status:'状态值无效',
  snapshot_compare_minimum_not_met:'请至少选择 2 条历史信号快照',
  snapshot_compare_limit_exceeded:'每次最多选择 30 条历史信号快照',
  snapshot_compare_selection_invalid:'所选快照证据不完整或已失效，请重新选择',
  snapshot_compare_strategy_mismatch:'所选快照不属于同一策略',
  snapshot_compare_strategy_version_mismatch:'所选快照的策略版本不一致',
  snapshot_compare_symbol_mismatch:'所选快照的交易品种不一致',
  snapshot_compare_schema_mismatch:'所选快照的输出结构不一致',
  history_compare_job_already_running:'已有模型评测任务正在运行，请等待任务结束',
  history_compare_job_not_found:'模型评测任务不存在或已删除',
  strategy_not_found:'平台策略不存在或已删除',
  symbols_required:'请至少配置一个交易品种',
  invalid_visibility_status:'策略状态无效',
  invalid_scope:'策略范围无效',
  strategy_scope_immutable:'策略范围创建后不能修改',
  strategy_delete_confirmation_mismatch:'策略名称确认不一致',
  strategy_delete_version_changed:'策略版本已变化，请重新确认',
  strategy_delete_impact_changed:'策略订阅影响已变化，请重新确认',
  strategy_delete_active_subscriptions_unconfirmed:'请确认同时停止正在运行的订阅',
}

function adminAiError(res, error) {
  const code = String(error?.message || 'ai_operations_failed')
  const status = code.includes('not_found') ? 404 : 400
  res.status(status).json({ ok:false, error:AI_OPERATION_ERRORS[code] || 'AI 运营配置更新失败', code })
}

router.get('/admin/ai/overview', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, operations:await getAdminAiOperationsOverview() }) }
  catch (error) {
    console.error('[AdminConsole] AI operations overview failed:', error)
    res.status(500).json({ ok:false, error:'AI 运营数据加载失败' })
  }
})

router.get('/admin/ai/strategies', authMiddleware, adminOnly, async (req, res) => {
  try {
    const strategies = await listStrategies(req.user.id, req.user.role, { scope:'platform', includeInactive:true })
    res.json({ ok:true, strategies })
  } catch (error) { adminAiError(res, error) }
})

router.get('/admin/ai/strategies/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const strategy = await getStrategyById(Number(req.params.id), req.user.id, req.user.role)
    if (!strategy || strategy.scope !== 'platform') return res.status(404).json({ ok:false, error:'平台策略不存在或已删除', code:'strategy_not_found' })
    res.json({ ok:true, strategy })
  } catch (error) { adminAiError(res, error) }
})

router.post('/admin/ai/strategies', authMiddleware, adminOnly, async (req, res) => {
  try {
    const strategy = await createStrategy(req.user.id, req.user.role, { ...(req.body || {}), scope:'platform' })
    await reconcileAutoSchedulers()
    res.status(201).json({ ok:true, strategy })
  } catch (error) { adminAiError(res, error) }
})

router.put('/admin/ai/strategies/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const strategy = await updateStrategy(Number(req.params.id), req.user.id, req.user.role, { ...(req.body || {}), scope:'platform' })
    await reconcileAutoSchedulers()
    res.json({ ok:true, strategy })
  } catch (error) { adminAiError(res, error) }
})

router.get('/admin/ai/strategies/:id/delete-preview', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, preview:await getStrategyDeletionPreview(Number(req.params.id), req.user.id, req.user.role) }) }
  catch (error) { adminAiError(res, error) }
})

router.delete('/admin/ai/strategies/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const deleted = await deleteStrategy(Number(req.params.id), req.user.id, req.user.role, req.body || {})
    await reconcileAutoSchedulers()
    res.json({ ok:true, deleted })
  } catch (error) { adminAiError(res, error) }
})

router.get('/admin/ai/model-compare/setup', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [profiles, strategies] = await Promise.all([
      getUserModelProfiles(0),
      listStrategies(req.user.id, req.user.role, { scope:'platform', includeInactive:false }),
    ])
    res.json({
      ok:true,
      profiles:profiles.filter(profile => profile.status === 'active'),
      strategies:strategies.filter(strategy => strategy.visibility_status === 'active' && Number(strategy.is_active)),
      limits:{ models_minimum:2, models_maximum:5, snapshots_minimum:2, snapshots_maximum:30 },
    })
  } catch (error) {
    console.error('[AdminConsole] model compare setup failed:', error)
    res.status(500).json({ ok:false, error:'模型评测配置加载失败' })
  }
})

router.get('/admin/ai/model-compare/snapshots', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, ...(await listModelSnapshotSamples(req.user.id, req.query)) }) }
  catch (error) { adminAiError(res, error) }
})

router.get('/admin/ai/model-compare/jobs', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, jobs:await listHistoryCompareJobs(req.user.id, req.query.limit) }) }
  catch (error) { adminAiError(res, error) }
})

router.post('/admin/ai/model-compare/jobs', authMiddleware, adminOnly, async (req, res) => {
  try { res.status(202).json({ ok:true, job:await startHistoryCompareJob(req.user.id, req.body || {}) }) }
  catch (error) { adminAiError(res, error) }
})

router.get('/admin/ai/model-compare/jobs/:jobId', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, job:await getHistoryCompareJob(req.user.id, req.params.jobId) }) }
  catch (error) { adminAiError(res, error) }
})

router.delete('/admin/ai/model-compare/jobs/:jobId', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, job:await deleteHistoryCompareJob(req.user.id, req.params.jobId) }) }
  catch (error) { adminAiError(res, error) }
})

router.patch('/admin/ai/observer-sources/:id/runtime', authMiddleware, adminOnly, async (req, res) => {
  try {
    const source = await updateObserverSource(req.params.id, {
      auto_inference_enabled:req.body?.auto_inference_enabled,
      trade_send_enabled:req.body?.trade_send_enabled,
    })
    const runtime_sync = await synchronizeObserverSourceRuntime(source)
    res.json({ ok:true, source, runtime_sync })
  } catch (error) { adminAiError(res, error) }
})

router.get('/admin/ai/observer-candidates',authMiddleware,adminOnly,async(req,res)=>{
  try{
    const users=await queryAll(`SELECT id,email,nickname,role,plan,plan_source FROM users
      WHERE deletion_status='active' AND deleted_at IS NULL AND (role='admin' OR (plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at>=NOW())))
      ORDER BY role='admin' DESC,id`)
    const ids=users.map(user=>Number(user.id))
    const [accounts,strategies]=await Promise.all([
      ids.length?queryAll(`SELECT id,user_id,login_account,broker_server,nickname FROM trading_accounts WHERE is_deleted=0 AND user_id IN (${ids.map(()=>'?').join(',')}) ORDER BY user_id,updated_at DESC`,ids):[],
      queryAll(`SELECT id,title,version FROM auto_prompt_types WHERE scope='platform' AND is_active=1 AND deleted_at IS NULL AND visibility_status='active' ORDER BY sort_order,id`),
    ])
    res.json({ok:true,candidates:users.map(user=>({...user,bridge_online:isBridgeAlive(Number(user.id)),accounts:accounts.filter(account=>Number(account.user_id)===Number(user.id))})),strategies})
  }catch(error){console.error('[AdminConsole] observer candidates failed:',error);res.status(500).json({ok:false,error:'观摩源候选数据加载失败'})}
})
router.post('/admin/ai/observer-source-accounts',authMiddleware,adminOnly,async(req,res)=>{
  try{res.status(201).json({ok:true,account:await createObserverSourceAccount(req.user.id,req.body||{})})}catch(error){adminAiError(res,error)}
})
router.post('/admin/ai/observer-sources',authMiddleware,adminOnly,async(req,res)=>{
  try{const source=await createObserverSource(req.user.id,req.body||{});const runtime_sync=await synchronizeObserverSourceRuntime(source);res.status(201).json({ok:true,source,runtime_sync})}catch(error){adminAiError(res,error)}
})
router.put('/admin/ai/observer-sources/:id',authMiddleware,adminOnly,async(req,res)=>{
  try{const source=await updateObserverSource(req.params.id,req.body||{});const runtime_sync=await synchronizeObserverSourceRuntime(source);res.json({ok:true,source,runtime_sync})}catch(error){adminAiError(res,error)}
})
router.delete('/admin/ai/observer-sources/:id',authMiddleware,adminOnly,async(req,res)=>{
  try{const deleted=await deleteObserverSource(req.params.id);const runtime_sync=await synchronizeObserverSourceRuntime(deleted,{deleted:true});res.json({ok:true,deleted,runtime_sync})}catch(error){adminAiError(res,error)}
})

router.patch('/admin/ai/observer-channels/:id', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, channel:await updateObserverChannel(req.params.id, req.body || {}) }) }
  catch (error) { adminAiError(res, error) }
})
router.post('/admin/ai/observer-channels',authMiddleware,adminOnly,async(req,res)=>{
  try{res.status(201).json({ok:true,channel:await createObserverChannel(req.body||{})})}catch(error){adminAiError(res,error)}
})
router.put('/admin/ai/observer-channels/:id',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,channel:await updateObserverChannel(req.params.id,req.body||{})})}catch(error){adminAiError(res,error)}
})
router.delete('/admin/ai/observer-channels/:id',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,deleted:await deleteObserverChannel(req.params.id)})}catch(error){adminAiError(res,error)}
})
router.get('/admin/ai/observer-channels/:id/assignments',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,assignments:await listObserverChannelAssignments(req.params.id)})}catch(error){adminAiError(res,error)}
})
router.put('/admin/ai/observer-channels/:id/assignments',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,assignments:await replaceObserverChannelAssignments(req.params.id,req.user.id,req.body?.user_ids||[])})}catch(error){adminAiError(res,error)}
})

router.get('/admin/risk-audit/overview', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, ...(await getAdminRiskAuditOverview({ accountPage:req.query.account_page, accountPageSize:req.query.account_page_size })) }) }
  catch (error) { console.error('[AdminConsole] risk audit overview failed:', error); res.status(500).json({ ok:false, error:'风控与审计数据加载失败' }) }
})

router.get('/admin/risk-audit/admin-events', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, ...(await listAdminAuditEvents({ page:req.query.page, pageSize:req.query.page_size, search:req.query.search, targetType:req.query.target_type })) }) }
  catch (error) { console.error('[AdminConsole] admin audit events failed:', error); res.status(500).json({ ok:false, error:'管理操作记录加载失败' }) }
})

router.post('/admin/risk-audit/global-stop', authMiddleware, adminOnly, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled)
    const reason = String(req.body?.reason || '').trim()
    if (enabled && reason.length < 4) return res.status(400).json({ ok:false, error:'开启平台紧急停止时，请填写至少 4 个字的原因' })
    await setGlobalKillSwitch(req.user.id, req.user.role, enabled, reason)
    broadcastAdminEvent('risk', enabled ? 'global_stop_enabled' : 'global_stop_disabled', {
      enabled,
      reason:reason.slice(0, 160),
      changed_by:Number(req.user.id),
    }, { scopes:['overview', 'risk-audit'], refresh:true })
    res.json({ ok:true })
  } catch (error) { adminAiError(res, error) }
})
router.get('/admin/risk-audit/platform-policy',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,policy:await getAdminPlatformRiskPolicy()})}
  catch(error){console.error('[AdminConsole] platform risk policy failed:',error);res.status(500).json({ok:false,error:'平台风控规则加载失败'})}
})
router.put('/admin/risk-audit/platform-policy',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,result:await saveAdminPlatformRiskPolicy({actorId:req.user.id,values:req.body?.values||{},controls:req.body?.controls||{},reason:req.body?.reason||''})})}
  catch(error){console.error('[AdminConsole] platform risk policy save failed:',error);res.status(400).json({ok:false,error:'平台风控规则保存失败，请检查输入范围'})}
})

router.get('/admin/content-system/overview', authMiddleware, adminOnly, async (req,res)=>{
  try{res.json({ok:true,overview:await getAdminContentSystemOverview()})}
  catch(error){console.error('[AdminConsole] content system overview failed:',error);res.status(500).json({ok:false,error:'内容与系统概览加载失败'})}
})
router.get('/admin/content-system/courses',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,...await listAdminCourses({page:req.query.page,pageSize:req.query.page_size,search:req.query.search,status:req.query.status})})}
  catch(error){console.error('[AdminConsole] course list failed:',error);res.status(500).json({ok:false,error:'课程列表加载失败'})}
})
router.get('/admin/content-system/courses/:courseId',authMiddleware,adminOnly,async(req,res)=>{
  try { const course=await getAdminCourse(req.params.courseId); if(!course)return res.status(404).json({ok:false,error:'课程不存在'}); res.json({ok:true,course}) }
  catch(error){console.error('[AdminConsole] course detail failed:',error);res.status(400).json({ok:false,error:'课程详情加载失败'})}
})
router.post('/admin/content-system/courses',authMiddleware,adminOnly,async(req,res)=>{
  try { res.json({ok:true,course:await saveAdminCourse(req.body||{})}) }
  catch(error){const labels={course_title_required:'请填写课程标题',invalid_course_category:'请选择正确的发布栏目',invalid_course_content_type:'请选择正确的课程类型',course_not_found:'课程不存在'};res.status(400).json({ok:false,error:labels[error.message]||'课程保存失败'})}
})
router.delete('/admin/content-system/courses/:courseId',authMiddleware,adminOnly,async(req,res)=>{
  try { res.json({ok:true,course:await deleteAdminCourse(req.params.courseId)}) }
  catch(error){res.status(error.message==='course_not_found'?404:400).json({ok:false,error:error.message==='course_not_found'?'课程不存在':'课程删除失败'})}
})
router.get('/admin/content-system/feedback',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,...await listAdminFeedback({page:req.query.page,pageSize:req.query.page_size,search:req.query.search,type:req.query.type})})}
  catch(error){console.error('[AdminConsole] feedback list failed:',error);res.status(500).json({ok:false,error:'用户反馈加载失败'})}
})
router.get('/admin/content-system/engagement',authMiddleware,adminOnly,async(req,res)=>{
  try{
    const [summary,leaderboard]=await Promise.all([
      queryOne(`SELECT
        (SELECT COUNT(*) FROM posts) AS posts_total,
        (SELECT COUNT(*) FROM comments) AS comments_total,
        (SELECT COUNT(*) FROM post_replies) AS replies_total,
        (SELECT COUNT(*) FROM progress WHERE completed=1) AS lessons_completed,
        (SELECT COUNT(DISTINCT user_id) FROM progress WHERE completed=1) AS learners_active,
        (SELECT COUNT(*) FROM progress WHERE quiz_passed=1) AS quizzes_passed`),
      queryAll(`SELECT u.id,u.uid,u.nickname,u.email,u.plan,u.plan_expires_at,
        COUNT(p.episode_id) AS lessons_started,
        SUM(CASE WHEN p.completed=1 THEN 1 ELSE 0 END) AS lessons_completed,
        SUM(CASE WHEN p.quiz_passed=1 THEN 1 ELSE 0 END) AS quizzes_passed
        FROM users u JOIN progress p ON p.user_id=u.id
        WHERE COALESCE(u.deletion_status,'')<>'anonymized'
        GROUP BY u.id,u.uid,u.nickname,u.email,u.plan,u.plan_expires_at
        HAVING lessons_completed>0
        ORDER BY lessons_completed DESC,quizzes_passed DESC,lessons_started DESC LIMIT 100`),
    ])
    res.json({ok:true,summary:Object.fromEntries(Object.entries(summary||{}).map(([key,value])=>[key,Number(value||0)])),leaderboard:leaderboard.map(row=>({...row,lessons_started:Number(row.lessons_started||0),lessons_completed:Number(row.lessons_completed||0),quizzes_passed:Number(row.quizzes_passed||0)}))})
  }catch(error){console.error('[AdminConsole] engagement overview failed:',error);res.status(500).json({ok:false,error:'学习与社区数据加载失败'})}
})
router.get('/admin/content-system/videos',authMiddleware,adminOnly,async(req,res)=>{
  try{
    const rows=await queryAll(`SELECT c.episode_id,c.number,c.title,c.access_level,c.has_stream_video,c.local_video_path,c.bilibili_id,c.youtube_id,
      vs.id AS stream_id,vs.local_path,vs.qiniu_key,vs.duration,vs.title AS stream_title,vs.access_level AS stream_access_level,
      vs.video_source,vs.stored_file_id,sf.storage_provider AS stored_file_provider,sf.status AS stored_file_status
      ,CASE WHEN vs.video_source='local_mp4' THEN '本地 MP4' WHEN vs.video_source='qiniu_mp4' THEN '七牛 MP4' WHEN c.bilibili_id<>'' OR vs.bilibili_id<>'' THEN 'Bilibili' WHEN c.youtube_id<>'' THEN 'YouTube' ELSE '外部来源' END AS video_source_label
      FROM courses c LEFT JOIN video_streams vs ON vs.episode_id=c.episode_id
      LEFT JOIN stored_files sf ON sf.id=vs.stored_file_id
      ORDER BY c.sort_order,c.number,c.episode_id`)
    res.json({ok:true,courses:rows.map(row=>({...row,id:Number(row.episode_id),number:Number(row.number||0),has_stream_video:Boolean(Number(row.has_stream_video)),access_level:row.stream_access_level||row.access_level||'free'}))})
  }catch(error){console.error('[AdminConsole] hosted videos failed:',error);res.status(500).json({ok:false,error:'课程视频数据加载失败'})}
})

router.get('/admin/commercial/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [orders, referrals, notifications] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'paid') AS paid,
        SUM(status IN ('pending','processing')) AS pending,
        SUM(status IN ('failed','expired','cancelled')) AS closed,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_confirmed ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN status = 'paid' AND DATE(paid_at) = CURDATE() THEN amount_confirmed ELSE 0 END), 0) AS today_revenue
        FROM orders`),
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'pending') AS pending,
        SUM(status = 'approved') AS approved,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN commission ELSE 0 END), 0) AS approved_amount
        FROM referrals`),
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'failed') AS failed,
        SUM(status IN ('pending','sending')) AS pending
        FROM membership_expiry_notifications`),
    ])
    res.json({ ok:true, overview:{
      orders_total:Number(orders?.total || 0),
      orders_paid:Number(orders?.paid || 0),
      orders_pending:Number(orders?.pending || 0),
      orders_closed:Number(orders?.closed || 0),
      revenue:Number(orders?.revenue || 0),
      today_revenue:Number(orders?.today_revenue || 0),
      referrals_total:Number(referrals?.total || 0),
      referrals_pending:Number(referrals?.pending || 0),
      referrals_approved:Number(referrals?.approved || 0),
      referral_approved_amount:Number(referrals?.approved_amount || 0),
      notifications_total:Number(notifications?.total || 0),
      notifications_failed:Number(notifications?.failed || 0),
      notifications_pending:Number(notifications?.pending || 0),
    } })
  } catch (error) {
    console.error('[AdminConsole] commercial overview failed:', error)
    res.status(500).json({ ok:false, error:'商业运营概览加载失败' })
  }
})

router.get('/admin/commercial/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const page = integer(req.query.page, 1, 1, 100000)
    const pageSize = integer(req.query.page_size, 20, 5, 100)
    const status = String(req.query.status || 'all').trim()
    const search = String(req.query.search || '').trim().slice(0, 100)
    const offset = (page - 1) * pageSize
    const where = []
    const params = []
    if (ORDER_STATUSES.has(status)) { where.push('o.status = ?'); params.push(status) }
    if (search) {
      const keyword = `%${search}%`
      where.push('(o.order_no LIKE ? OR o.order_id LIKE ? OR u.uid LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?)')
      params.push(keyword, keyword, keyword, keyword, keyword)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${clause}`, params)
    const rows = await queryAll(`SELECT o.id, o.order_id, o.order_no, o.user_id, o.plan, o.plan_label,
      o.period, o.period_label, o.amount, o.amount_confirmed, o.currency, o.status,
      o.status_label, o.payment_method, o.paid_at, o.created_at,
      u.uid AS user_uid, u.nickname AS user_name, u.email AS user_email
      FROM orders o LEFT JOIN users u ON u.id = o.user_id ${clause}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset])
    const total = Number(totalRow?.total || 0)
    res.json({ ok:true, orders:rows.map(serializeOrder), pagination:{
      page, page_size:pageSize, total, total_pages:Math.max(1, Math.ceil(total / pageSize)),
    } })
  } catch (error) {
    console.error('[AdminConsole] commercial orders failed:', error)
    res.status(500).json({ ok:false, error:'订单记录加载失败' })
  }
})

router.get('/admin/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [users, membership, activity, trading, review] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS total,
        SUM(DATE(created_at) = CURDATE()) AS today_new
        FROM users WHERE COALESCE(deletion_status, '') <> 'anonymized'`),
      queryOne(`SELECT
        SUM(plan = 'plus' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS plus_active,
        SUM(plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS pro_active,
        SUM(plan IN ('plus','pro') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS expired
        FROM users WHERE COALESCE(deletion_status, '') <> 'anonymized'`),
      queryOne(`SELECT
        SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS online_now,
        SUM(last_seen_at >= CURDATE()) AS active_today
        FROM users WHERE COALESCE(deletion_status, '') <> 'anonymized'`),
      queryOne(`SELECT
        COUNT(DISTINCT CASE WHEN is_deleted = 0 THEN user_id END) AS connected_users,
        COUNT(CASE WHEN is_deleted = 0 THEN 1 END) AS accounts
        FROM trading_accounts`),
      queryOne(`SELECT COUNT(*) AS pending_reviews FROM period_review_cases
        WHERE status IN ('ready', 'generating', 'draft', 'edited', 'failed')`),
    ])
    res.json({ ok:true, overview:{
      total_users:Number(users?.total || 0),
      today_new_users:Number(users?.today_new || 0),
      plus_active:Number(membership?.plus_active || 0),
      pro_active:Number(membership?.pro_active || 0),
      expired_memberships:Number(membership?.expired || 0),
      online_now:Number(activity?.online_now || 0),
      active_today:Number(activity?.active_today || 0),
      connected_users:Number(trading?.connected_users || 0),
      trading_accounts:Number(trading?.accounts || 0),
      pending_reviews:Number(review?.pending_reviews || 0),
    } })
  } catch (error) {
    console.error('[AdminConsole] overview failed:', error)
    res.status(500).json({ ok:false, error:'管理概览加载失败' })
  }
})

router.get('/admin/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const page = integer(req.query.page, 1, 1, 100000)
    const pageSize = integer(req.query.page_size, 20, 5, 100)
    const search = String(req.query.search || '').trim()
    const membership = String(req.query.membership || 'all')
    const offset = (page - 1) * pageSize
    const where = ["COALESCE(u.deletion_status, '') <> 'anonymized'"]
    const params = []
    if (search) {
      where.push('(u.email LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ? OR u.uid LIKE ?)')
      const keyword = `%${search}%`
      params.push(keyword, keyword, keyword, keyword)
    }
    if (membership === 'active') where.push("u.plan IN ('plus','pro') AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())")
    if (membership === 'expired') where.push("u.plan IN ('plus','pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()")
    if (membership === 'free') where.push("u.plan = 'free'")
    if (membership === 'plus' || membership === 'pro') where.push('u.plan = ?'), params.push(membership)
    const clause = where.join(' AND ')
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM users u WHERE ${clause}`, params)
    const rows = await queryAll(`SELECT u.id, u.uid, u.email, u.phone, u.nickname, u.avatar, u.role,
      u.plan, u.plan_source, u.plan_expires_at, u.created_at, u.last_seen_at,
      (u.plan IN ('plus','pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()) AS membership_expired,
      (SELECT COUNT(*) FROM trading_accounts ta WHERE ta.user_id = u.id AND ta.is_deleted = 0) AS mt5_account_count,
      (SELECT COUNT(*) FROM auto_prompt_types apt WHERE apt.owner_user_id = u.id AND apt.deleted_at IS NULL) AS strategy_count
      FROM users u WHERE ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset])
    const total = Number(totalRow?.total || 0)
    res.json({ ok:true, users:rows.map(row => serializeUser({
      ...row,
      bridge_connected:isBridgeAlive(Number(row.id)) ? 1 : 0,
    })), pagination:{
      page, page_size:pageSize, total, total_pages:Math.max(1, Math.ceil(total / pageSize)),
    } })
  } catch (error) {
    console.error('[AdminConsole] users failed:', error)
    res.status(500).json({ ok:false, error:'用户目录加载失败' })
  }
})

router.get('/admin/users/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.userId)
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ ok:false, error:'用户编号无效' })
    const user = await queryOne(`SELECT u.id, u.uid, u.email, u.phone, u.nickname, u.avatar, u.role,
      u.plan, u.plan_source, u.plan_expires_at, u.created_at, u.last_seen_at,
      (u.plan IN ('plus','pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()) AS membership_expired
      FROM users u WHERE u.id = ? AND COALESCE(u.deletion_status, '') <> 'anonymized'`, [userId])
    if (!user) return res.status(404).json({ ok:false, error:'用户不存在' })
    const [settings, accounts, subscriptions] = await Promise.all([
      queryOne('SELECT trade_send_enabled, auto_reasoning_enabled, updated_at FROM user_bridge_settings WHERE user_id = ?', [userId]),
      queryAll(`SELECT id, broker_server, login_account AS mt5_login, nickname, observe_status, created_at, updated_at
        FROM trading_accounts WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC`, [userId]),
      queryAll(`SELECT ss.id, ss.strategy_id, ss.execution_enabled, ss.created_at, apt.title AS strategy_title,
        apt.scope AS strategy_scope FROM strategy_subscriptions ss
        LEFT JOIN auto_prompt_types apt ON apt.id = ss.strategy_id
        WHERE ss.user_id = ? AND ss.is_deleted = 0 ORDER BY ss.updated_at DESC`, [userId]),
    ])
    res.json({ ok:true, user:serializeUser(user), runtime:settings || {
      trade_send_enabled:0, auto_reasoning_enabled:0, updated_at:null,
    }, accounts, subscriptions })
  } catch (error) {
    console.error('[AdminConsole] user detail failed:', error)
    res.status(500).json({ ok:false, error:'用户档案加载失败' })
  }
})

router.patch('/admin/users/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const profile = await updateAdminUserProfile({
      actorUserId:req.user.id,
      targetUserId:req.params.userId,
      input:req.body || {},
    })
    res.json({ ok:true, profile })
  } catch (error) {
    const status = String(error?.message || '') === 'user_not_found' ? 404 : 400
    res.status(status).json({ ok:false, error:translateAdminProfileError(error) })
  }
})

router.delete('/admin/users/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await queryOne('SELECT email FROM users WHERE id = ?', [Number(req.params.userId)])
    if (!user) return res.status(404).json({ ok:false, error:'用户不存在' })
    if (String(req.body?.confirm_email || '').trim().toLowerCase() !== String(user.email || '').trim().toLowerCase()) {
      return res.status(400).json({ ok:false, error:'确认邮箱与用户邮箱不一致' })
    }
    res.json({ ok:true, deleted:await anonymizeAdminUser({ actor:req.user, targetUserId:req.params.userId }) })
  } catch (error) {
    const labels={invalid_user_id:'用户编号无效',user_not_found:'用户不存在',admin_user_cannot_be_deleted:'管理员账号不能删除'}
    const code=String(error?.message||'')
    res.status(code==='user_not_found'?404:400).json({ok:false,error:labels[code]||'用户删除失败'})
  }
})

export default router
