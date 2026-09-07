import { createRouter, createWebHistory } from 'vue-router'
import { useAdminSession } from '~/features/auth/session'

const moduleRoutes = [
  { path: '/users', title: '用户与会员', description: '用户档案、会员、权限与会话管理将在对应阶段接入。' },
  { path: '/content', title: '内容与课程', description: '主站内容、课程、媒体资产与发布流程将在对应阶段接入。' },
  { path: '/strategies', title: '策略管理', description: '平台策略、版本、发布与订阅运营将在对应阶段接入。' },
  { path: '/models', title: '共享模型', description: '平台共享模型与用途路由将在对应阶段接入。' },
  { path: '/risk', title: '平台风控', description: '风控模板、全局规则和决策审计将在对应阶段接入。' },
  { path: '/bridge', title: 'Bridge 运营', description: '版本、连接、额度和终端诊断将在对应阶段接入。' },
  { path: '/commercial', title: '商业与订单', description: '会员订单、支付、返佣和到期提醒将在对应阶段接入。' },
  { path: '/notifications', title: '通知中心', description: '站内通知、短信、邮件与发送记录将在对应阶段接入。' },
  { path: '/site-settings', title: '站点与域名', description: '三端域名、页面 TDK 和公开站点配置将在对应阶段接入。' },
  { path: '/audit', title: '审计日志', description: '管理员操作与敏感变更审计将在对应阶段接入。' },
  { path: '/system', title: '系统设置', description: '运行参数、任务状态与只读诊断将在对应阶段接入。' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('~/features/auth/LoginView.vue'),
      meta: { title: '登录', public: true },
    },
    {
      path: '/',
      name: 'overview',
      component: () => import('~/features/overview/OverviewView.vue'),
      meta: { title: '运营概览' },
    },
    ...moduleRoutes.map((route) => ({
      path: route.path,
      component: route.path === '/system' ? () => import('~/features/settings/SystemSettingsView.vue') : () => import('~/features/shell/ModulePlaceholderView.vue'),
      meta: { title: route.title, description: route.description },
    })),
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const { load } = useAdminSession()
  if (await load()) return true
  return { path: '/login', query: { next: to.fullPath } }
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '管理后台')}｜量见`
})
