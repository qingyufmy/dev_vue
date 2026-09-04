import { createRouter, createWebHistory } from 'vue-router'
import { useTradeSession } from '~/features/auth/session'

const moduleRoutes = [
  { path: '/market', title: '市场行情', description: '宏观环境、关键因子与黄金市场状态将在对应阶段接入。' },
  { path: '/settings/models', title: '模型配置', description: '个人与平台共享模型、默认模型和用途路由将在对应阶段接入。' },
  { path: '/bridge', title: '量见智桥', description: '终端档案、连接额度、诊断和下载入口将在对应阶段接入。' },
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
      name: 'home',
      component: () => import('~/features/home/HomeView.vue'),
      meta: { title: '交易概览' },
    },
    {
      path: '/analyst',
      name: 'analyst',
      component: () => import('~/features/analyst').then((module) => module.AnalystView),
      meta: { title: 'AI 分析师' },
    },
    {
      path: '/trader',
      name: 'trader',
      component: () => import('~/features/trader').then((module) => module.TraderView),
      meta: { title: 'AI 交易员' },
    },
    {
      path: '/risk',
      name: 'risk',
      component: () => import('~/features/risk').then((module) => module.RiskView),
      meta: { title: 'AI 风控师' },
    },
    {
      path: '/strategist',
      name: 'strategist',
      component: () => import('~/features/strategist').then((module) => module.StrategistView),
      meta: { title: 'AI 策略师' },
    },
    {
      path: '/reviewer',
      name: 'reviewer',
      component: () => import('~/features/reviewer').then((module) => module.ReviewerView),
      meta: { title: 'AI 复盘师' },
    },
    {
      path: '/trades',
      name: 'trades',
      component: () => import('~/features/trades').then((module) => module.TradesView),
      meta: { title: '交易记录' },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('~/features/audit').then((module) => module.AuditView),
      meta: { title: '系统审计' },
    },
    ...moduleRoutes.map((route) => ({
      path: route.path,
      component: () => import('~/features/shell/ModulePlaceholderView.vue'),
      meta: { title: route.title, description: route.description },
    })),
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const { load } = useTradeSession()
  if (await load()) return true
  return { path: '/login', query: { next: to.fullPath } }
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? 'AI 交易实验室')}｜量见`
})
