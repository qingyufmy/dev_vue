// 网站最近更新日志
// 显示在首页侧边栏「最近更新」板块，按日期倒序显示最新 8 条
//
// ⚠️ 原则：这里只写「用户能感知的内容/功能更新」，让学员知道有新东西可学
//    ✅ 可以写的：新视频上线、新文章、新专题、新知识点、新社区功能、新会员权益
//    ❌ 不要写的：性能优化、bug 修复、部署相关、数据库迁移、技术改造
//    这些对学员没意义，只会让列表变嘈杂。
//
// 字段:
//   date   YYYY-MM-DD
//   icon   表情图标（可选）
//   title  更新标题（显示在列表上）
//   target { type: 'episode', id }     → 点击跳转到该集数
//          { type: 'category', id }    → 点击切到首页并选中该分类
//          { type: 'path', url }       → 点击跳转到站内路径（如 /community）
//
// 新增更新时，直接往数组顶部加一条即可，越新越靠前。

export const siteUpdates = [
  {
    date: '2026-05-31',
    icon: '🫧',
    title: 'AI泡沫周期监控更新：5月31日数据',
    target: { type: 'path', url: '/ai泡沫周报/' },
  },
  {
    date: '2026-05-29',
    icon: '🎬',
    title: '第77期 · 行情思路分享，定时更新',
    target: { type: 'episode', id: 125 },
  },
  {
    date: '2026-05-27',
    icon: '🎬',
    title: '第76期 · 一个月内我如何使用ai抓到了涨幅很高的股票',
    target: { type: 'episode', id: 124 },
  },
  {
    date: '2026-05-24',
    icon: '🎬',
    title: '第75期 · 回答社区的一些问题，简单聊聊',
    target: { type: 'episode', id: 123 },
  },
  {
    date: '2026-05-20',
    icon: '🎬',
    title: '第74期 · 黄金思路更新',
    target: { type: 'episode', id: 122 },
  },
  {
    date: '2026-05-18',
    icon: '🎬',
    title: '第73期 · 黄金，比特币，美股思路。',
    target: { type: 'episode', id: 121 },
  },
  {
    date: '2026-05-17',
    icon: '⚙️',
    title: '新增研究：机器人零部件与材料产业链',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-16',
    icon: '▦',
    title: '新增研究：AI 存储产业链',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-16',
    icon: '🎬',
    title: '第72期 · 比特币思路更新',
    target: { type: 'episode', id: 120 },
  },
  {
    date: '2026-05-16',
    icon: '🚀',
    title: '更新研究：航天与卫星产业链',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-16',
    icon: '💾',
    title: '新增研究：InP 磷化铟激光器产业链',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-16',
    icon: '📡',
    title: '更新研究：美股光通信 / 光模块',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-16',
    icon: '🫧',
    title: 'AI泡沫周期监控更新：5月16日数据',
    target: { type: 'path', url: '/ai泡沫周报/' },
  },
  {
    date: '2026-05-16',
    icon: '📡',
    title: '更新研究：中国 / 港股光通信与光模块',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-16',
    icon: '◇',
    title: '更新研究：软件行业',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-05-15',
    icon: '🎬',
    title: '第71期 · 黄金性价比买入点位更新',
    target: { type: 'episode', id: 119 },
  },
  {
    date: '2026-05-15',
    icon: '🎬',
    title: '第70期 · 黄金思路更新',
    target: { type: 'episode', id: 118 },
  },
  {
    date: '2026-05-13',
    icon: '🎬',
    title: '第69期 · 黄金美股比特币思路',
    target: { type: 'episode', id: 117 },
  },
  {
    date: '2026-05-10',
    icon: '📅',
    title: '美股财报日',
    target: { type: 'path', url: '/earnings/' },
  },
  {
    date: '2026-05-10',
    icon: '🫧',
    title: 'AI泡沫周期监控',
    target: { type: 'path', url: '/ai泡沫周报/' },
  },
  {
    date: '2026-05-10',
    icon: '📊',
    title: 'AI 转折点月度报告',
    target: { type: 'path', url: '/weekly/' },
  },
  {
    date: '2026-05-08',
    icon: '🎬',
    title: '第68期 · 5月8日黄金思路更新',
    target: { type: 'episode', id: 116 },
  },
  {
    date: '2026-04-28',
    icon: '🎬',
    title: '第67期 · 比特币黄金最新思路',
    target: { type: 'episode', id: 115 },
  },
  {
    date: '2026-04-25',
    icon: '🤖',
    title: '新增研究：全球 Physical AI 与机器人执行链股票买入排名',
    target: { type: 'path', url: '/research/physical-ai-robotics.html' },
  },
  {
    date: '2026-04-25',
    icon: '🏛️',
    title: '新增研究：美国政府入股与战略产业链股票买入排名',
    target: { type: 'path', url: '/research/us-strategic-industries.html' },
  },
  {
    date: '2026-04-25',
    icon: '🩺',
    title: '新增研究：全球 AI 医学结合产业链股票买入排名',
    target: { type: 'path', url: '/research/ai-medicine.html' },
  },
  {
    date: '2026-04-25',
    icon: '🔋',
    title: '新增研究：全球储能电池产业链股票买入排名',
    target: { type: 'path', url: '/research/energy-storage.html' },
  },
  {
    date: '2026-04-24',
    icon: '📈',
    title: '均线交叉系统系统教学全新更新',
    target: { type: 'episode', id: 82 },
  },
  {
    date: '2026-04-24',
    icon: '🌡️',
    title: '市场情绪分析系统教学全新更新',
    target: { type: 'episode', id: 85 },
  },
  {
    date: '2026-04-24',
    icon: '🧠',
    title: '交易心理学系统教学全新更新',
    target: { type: 'episode', id: 105 },
  },
  {
    date: '2026-04-24',
    icon: '🎬',
    title: '第66期 · 黄金周末思路',
    target: { type: 'episode', id: 114 },
  },
  {
    date: '2026-04-24',
    icon: '🪙',
    title: '新增研究：全球虚拟货币产业链股票买入排名',
    target: { type: 'path', url: '/research/crypto.html' },
  },
  {
    date: '2026-04-24',
    icon: '⚡',
    title: '新增研究：全球电力产业链股票买入排名',
    target: { type: 'path', url: '/research/electric-power.html' },
  },
  {
    date: '2026-04-24',
    icon: '🛢️',
    title: '新增研究：全球能源产业链股票买入排名',
    target: { type: 'path', url: '/research/energy.html' },
  },
  {
    date: '2026-04-24',
    icon: '🚀',
    title: '新增研究：全球航空航天与国防航天产业链股票买入排名',
    target: { type: 'path', url: '/research/aerospace.html' },
  },
  {
    date: '2026-04-24',
    icon: '☀️',
    title: '新增研究：全球光伏产业链股票买入排名',
    target: { type: 'path', url: '/research/solar.html' },
  },
  {
    date: '2026-04-24',
    icon: '💾',
    title: '新增研究：全球半导体产业链股票买入排名',
    target: { type: 'path', url: '/research/semiconductor.html' },
  },
  {
    date: '2026-04-24',
    icon: '🔲',
    title: '新增研究：全球 CPU 产业链股票买入排名',
    target: { type: 'path', url: '/research/cpu.html' },
  },
  {
    date: '2026-04-23',
    icon: '📈',
    title: '新上线：美股 GPT 深度研究资料（6 份）',
    target: { type: 'path', url: '/research/' },
  },
  {
    date: '2026-04-23',
    icon: '📺',
    title: 'Smart Money 概念：新增视频讲解',
    target: { type: 'episode', id: 90 },
  },
  {
    date: '2026-04-23',
    icon: '🎬',
    title: '第65期 · 黄金比特币更新',
    target: { type: 'episode', id: 113 },
  },
  {
    date: '2026-04-22',
    icon: '🎬',
    title: '第64期 · 黄金思路更新',
    target: { type: 'episode', id: 112 },
  },
  {
    date: '2026-04-22',
    icon: '🎬',
    title: '第63期 · 比特币思路更新',
    target: { type: 'episode', id: 111 },
  },
  {
    date: '2026-04-21',
    icon: '📺',
    title: '真突破与假突破分辨：新增视频讲解',
    target: { type: 'episode', id: 80 },
  },
  {
    date: '2026-04-20',
    icon: '📊',
    title: '新增「订单流分析入门」Order Flow 专题',
    target: { type: 'episode', id: 97 },
  },
  {
    date: '2026-04-20',
    icon: '🏴',
    title: '新增「旗形与楔形」形态分析专题',
    target: { type: 'episode', id: 73 },
  },
  {
    date: '2026-04-20',
    icon: '🔺',
    title: '新增「三角形态解析」形态分析专题',
    target: { type: 'episode', id: 72 },
  },
  {
    date: '2026-04-20',
    icon: '🔄',
    title: 'ICT 交易方法论 专题全新升级',
    target: { type: 'episode', id: 91 },
  },
  {
    date: '2026-04-20',
    icon: '📐',
    title: '威科夫（Wyckoff）理论 专题全新升级',
    target: { type: 'episode', id: 92 },
  },
  {
    date: '2026-04-20',
    icon: '📈',
    title: 'Smart Money 概念专题全新升级',
    target: { type: 'episode', id: 90 },
  },
  {
    date: '2026-04-20',
    icon: '⚡',
    title: '新增「真突破与假突破分辨」交易策略专题',
    target: { type: 'episode', id: 80 },
  },
  {
    date: '2026-04-20',
    icon: '🌀',
    title: '新增「缠论·缠中说缠」技术模型专题',
    target: { type: 'episode', id: 94 },
  },
  {
    date: '2026-04-19',
    icon: '🎬',
    title: '第62期 · 黄金白银比特币下周思路',
    target: { type: 'episode', id: 110 },
  },
  {
    date: '2026-04-19',
    icon: '📺',
    title: '头肩顶与头肩底：新增视频讲解',
    target: { type: 'episode', id: 70 },
  },
  {
    date: '2026-04-18',
    icon: '📐',
    title: '新增「双顶与双底形态」专题文章',
    target: { type: 'episode', id: 71 },
  },
  {
    date: '2026-04-18',
    icon: '📺',
    title: '维加斯通道：新增视频讲解',
    target: { type: 'episode', id: 64 },
  },
  {
    date: '2026-04-14',
    icon: '🎬',
    title: '第61期 · 比特币等水下两绿柱',
    target: { type: 'episode', id: 109 },
  },
  {
    date: '2026-04-13',
    icon: '🎬',
    title: '第60期 · 从历史走势找规律（会员专属）',
    target: { type: 'episode', id: 12 },
  },
  {
    date: '2026-04-12',
    icon: '💬',
    title: '社区板块上线：分享思路、互动讨论',
    target: { type: 'path', url: '/community' },
  },
]
