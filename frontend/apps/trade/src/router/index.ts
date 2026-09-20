import { createRouter, createWebHistory } from 'vue-router'
import { useTradeSession, loadLoginView } from '~/features/auth'
import { loadHomeView } from '~/features/home'
import { loadModelsView } from '~/features/models'

const moduleRoutes = [
  { path: '/settings/models', title: '模型配置', description: '个人与平台共享模型、默认模型和用途路由将在对应阶段接入。' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {path:'/settings/personal',name:'personal-settings',component:()=>import('~/features/personal').then(m=>m.loadPersonalSettingsView()),meta:{title:'个人设置'}},
    { path: '/bridge/authorize', name: 'bridge-authorize', component: () => import('~/features/bridge').then((module) => module.BridgeAuthorizationView), meta: { title: '授权量见智桥' } },
    { path: '/market', redirect: '/' },
    {
      path: '/bridge', name: 'bridge',
      component: () => import('~/features/bridge').then((module) => module.BridgeView),
      meta: { title: '量见智桥' },
    },
    {
      path: '/login',
      name: 'login',
      component: loadLoginView,
      meta: { title: '登录', public: true },
    },
    {
      path: '/',
      name: 'home',
      component: loadHomeView,
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
      component: loadModelsView,
      meta: { title: route.title, description: route.description },
    })),
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const { load, issue } = useTradeSession()
  if (await load()) return true
  if (issue.value === 'none') return false
  return { path: '/login', query: { next: to.fullPath, ...(issue.value !== 'signed-out' ? { reason: issue.value } : {}) } }
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? 'AI 交易实验室')}｜量见`
})
