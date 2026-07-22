// 课程分类
export const categories = [
  { id: 'morning', name: '早盘解读' },
  { id: 'indicator', name: '技术指标' },
  { id: 'pattern', name: '形态分析' },
  { id: 'strategy', name: '交易策略' },
  { id: 'advanced', name: '经济指标' },
]

// 卡片渐变背景色
export const gradients = [
  'linear-gradient(135deg, #667eea, #764ba2)',
  'linear-gradient(135deg, #f093fb, #f5576c)',
  'linear-gradient(135deg, #4facfe, #00f2fe)',
  'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)',
  'linear-gradient(135deg, #a18cd1, #fbc2eb)',
  'linear-gradient(135deg, #fccb90, #d57eeb)',
  'linear-gradient(135deg, #e0c3fc, #8ec5fc)',
  'linear-gradient(135deg, #f5576c, #ff6f91)',
  'linear-gradient(135deg, #13547a, #80d0c7)',
  'linear-gradient(135deg, #ff9a9e, #fad0c4)',
  'linear-gradient(135deg, #a1c4fd, #c2e9fb)',
  'linear-gradient(135deg, #d4fc79, #96e6a1)',
  'linear-gradient(135deg, #84fab0, #8fd3f4)',
  'linear-gradient(135deg, #fddb92, #d1fdff)',
  'linear-gradient(135deg, #c1dfc4, #deecdd)',
  'linear-gradient(135deg, #0ba360, #3cba92)',
  'linear-gradient(135deg, #00cdac, #8ddad5)',
  'linear-gradient(135deg, #f77062, #fe5196)',
  'linear-gradient(135deg, #c471f5, #fa71cd)',
]

// 60期课程数据
const episodeRaw = [
  // ===== 基础入门 (1-10) =====
  {
    title: '裸K交易与穿头破脚假突破',
    description: '25年10月11日 · 第一期',
    category: 'indicator',
    duration: '18:30',
    youtubeId: '05JRtvPsk-M',
    cover: '/covers/ep01.webp',
  },
  {
    title: '暴跌长针复盘与期权看多策略',
    description: '25年10月12日 · 第二期',
    category: 'indicator',
    duration: '22:15',
    youtubeId: 'Bw8rDLGGA_w',
    cover: '/covers/ep02.webp',
  },
  {
    title: '均线偏空下的多空逻辑博弈',
    description: '25年10月23日 · 第三期',
    category: 'indicator',
    duration: '19:45',
    youtubeId: 'aJA3vIda0wg',
    cover: '/covers/ep03.webp',
  },
  {
    title: '黄金暴跌抄底与远离币安合约',
    description: '25年10月28日 · 第四期',
    category: 'indicator',
    duration: '16:20',
    youtubeId: 'bgyGzldmVJo',
    cover: '/covers/ep04.webp',
  },
  {
    title: '降息前行情推演及黄金顶背离',
    description: '25年10月29日 · 第五期',
    category: 'indicator',
    duration: '22:30',
    youtubeId: 'iNuXmPh0oUY',
    cover: '/covers/ep05.webp',
  },
  {
    title: '均线缠绕震荡与防范下跌扩大',
    description: '25年11月1日 · 第六期',
    category: 'indicator',
    duration: '20:30',
    youtubeId: '1EE5hOJiarA',
    cover: '/covers/ep06.webp',
  },
  {
    title: '熊市水下金叉见顶与黄金做空',
    description: '25年11月11日 · 第七期',
    category: 'indicator',
    duration: '17:55',
    youtubeId: 'xNciWvo-Fpw',
    cover: '/covers/ep07.webp',
  },
  {
    title: '均线空头排列与黄金背离做空',
    description: '25年11月15日 · 第八期',
    category: 'indicator',
    duration: '21:40',
    youtubeId: 'mTvpUp-wECw',
    cover: '/covers/ep08.webp',
  },
  {
    title: '区间阻力做空与黄金VWAP应用',
    description: '25年11月17日 · 第九期',
    category: 'indicator',
    duration: '14:50',
    youtubeId: '6JwjOrSpjkY',
    cover: '/covers/ep09.webp',
  },

  {
    title: 'BTC日线金叉与VWAP波段做空',
    description: '25年11月29日 · 第十一期',
    number: 11,
    category: 'indicator',
    duration: '19:15',
    youtubeId: '-cRNwXrmMQE',
    cover: '/covers/ep10.webp',
  },

  {
    title: '针头二探预期与月线死叉推演',
    description: '25年12月1日 · 第十二期',
    number: 12,
    category: 'indicator',
    duration: '20:00',
    youtubeId: 'hCnLfx-y8A8',
    cover: '/covers/ep11.webp',
  },

  // ===== 第60期 会员专属（number: 60 硬编码，不可更改）=====
  {
    title: '黄金去5000之前能否出现一次绝佳的买点，结合"和谐形态"与历史周期寻找机会',
    description: '26年4月12日 · 第六十期',
    number: 60,
    category: 'indicator',
    duration: '20:00',
    cover: '/covers/ep60.webp',
  },

  {
    title: '黄金走弱与筹码密集区做空',
    description: '25年12月2日 · 第十三期',
    number: 13,
    category: 'indicator',
    duration: '20:00',
    youtubeId: 'KUtjKpM2VEc',
    cover: '/covers/ep12.webp',
  },

  {
    title: 'BTC触及关键支撑与现货建仓',
    description: '25年11月22日 · 第十期',
    number: 10,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'upwxoQYCdQw',
  },

  // ===== EP.14-59 早盘解读 =====
  {
    title: 'VWAP实战教学与连续测试破位',
    description: '25年12月6日 · 第十四期',
    number: 14,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '_kcWH_97qGs',
  },
  {
    title: '降息前后推演与防范日本加息',
    description: '25年12月6日 · 第十五期',
    number: 15,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '50k1unD6aJo',
  },
  {
    title: 'BTC反向头肩顶与画门行情',
    description: '25年12月10日 · 第十六期',
    number: 16,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'PeaeeybYf7U',
  },
  {
    title: '降息落地走弱与关键节点止损',
    description: '25年12月11日 · 第十七期',
    number: 17,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'T4QoVadshQA',
  },
  {
    title: '黄金短线波段与趋势单的抉择',
    description: '25年12月14日 · 第十八期',
    number: 18,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'vwpsktcpQbU',
  },
  {
    title: '震荡末期筹码分布与趋势线突破',
    description: '25年12月20日 · 第十九期',
    number: 19,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'KvEYkz6JX_Y',
  },
  {
    title: '伦敦金定盘时间与期现货对比',
    description: '25年12月24日 · 第二十期',
    number: 20,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'RQsnLznebAA',
  },
  {
    title: '白银摸顶做空与CME图表运用',
    description: '26年1月3日 · 第二十一期',
    number: 21,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'zQJj78UJjzk',
  },
  {
    title: 'BTC震荡突破与成交量分布图',
    description: '26年1月4日 · 第二十二期',
    number: 22,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'n5f9frnqGTQ',
  },
  {
    title: '阻力支撑转换与微策略逻辑博弈',
    description: '26年1月15日 · 第二十三期',
    number: 23,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'f01PWI3LWV8',
  },
  {
    title: '1月1日年线开盘价实战运用',
    description: '26年1月15日 · 第二十四期',
    number: 24,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'ULpNVjSHols',
  },
  {
    title: '年线与周月开盘价指标深度解析',
    description: '26年1月16日 · 第二十五期',
    number: 25,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'WDRRZ0CLJuM',
  },
  {
    title: '白银箱体假突破与摸顶做空逻辑',
    description: '26年1月30日 · 第二十六期',
    number: 26,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'TTPvhHGzRmw',
  },
  {
    title: '历史金银比测算与白银大顶确认',
    description: '26年1月31日 · 第二十七期',
    number: 27,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'uZ9cuLcGpzg',
  },
  {
    title: '刻舟22年破位走势与熊市做空',
    description: '26年2月2日 · 第二十八期',
    number: 28,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'lh52KWI-QdI',
  },
  {
    title: '交易级别的判定与多空波段操作',
    description: '26年2月3日 · 第二十九期',
    number: 29,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'GNMJeMr1CGg',
  },
  {
    title: '白银假跌破与抄底优选黄金逻辑',
    description: '26年2月5日 · 第三十期',
    number: 30,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'k6VK0wYHrrM',
  },
  {
    title: 'BTC四年周期重演与防范合约',
    description: '26年2月6日 · 第三十一期',
    number: 31,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '_TwGHZFqXPc',
  },
  {
    title: '顺应主跌趋势与防范逆势抄底',
    description: '26年2月8日 · 第三十二期',
    number: 32,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'FGItTZtniGo',
  },
  {
    title: '日线双孕线结构与实战运用',
    description: '26年2月11日 · 第三十三期',
    number: 33,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'ctCfb8goImM',
  },
  {
    title: '白银精准测顶与BTC穿头破脚',
    description: '26年2月22日 · 第三十四期',
    number: 34,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'kr_-77TRsUM',
  },
  {
    title: '主升浪暴跌与次高点反弹博弈',
    description: '26年2月24日 · 第三十五期',
    number: 35,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'V2cq_gVWQ2k',
  },
  {
    title: '刻舟求剑的本质与跨品种运用',
    description: '26年2月24日 · 第三十六期',
    number: 36,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'zmMoghLXfdw',
  },
  {
    title: '裸K实体支撑与高盈亏比入场',
    description: '26年2月25日 · 第三十七期',
    number: 37,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '5BxxTsTLIgM',
  },
  {
    title: '黄金短线回踩与目标位推演',
    description: '26年2月25日 · 第三十八期',
    number: 38,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'eEj7EU56m7s',
  },
  {
    title: '战火消息面博弈与周末流动性',
    description: '26年3月1日 · 第三十九期',
    number: 39,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'aqC1fGwDmd0',
  },
  {
    title: '真假突破判定与斐波那契画法',
    description: '26年3月3日 · 第四十期',
    number: 40,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'KQajssH5pk8',
  },
  {
    title: 'TRUMP代币晚宴逻辑与复盘',
    description: '26年3月13日 · 第四十一期',
    number: 41,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'homEzMa7EPQ',
  },
  {
    title: 'BTC长上影线与周线MACD死差',
    description: '26年3月16日 · 第四十二期',
    number: 42,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'JYjuwkttfUI',
  },
  {
    title: '金银假突破与白银见顶推演',
    description: '26年3月18日 · 第四十三期',
    number: 43,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'N57PjhHNx10',
  },
  {
    title: '黄金暴跌测底与RSI超卖修复',
    description: '26年3月20日 · 第四十四期',
    number: 44,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'SzLPFV5JEvE',
  },
  {
    title: 'BTC熊市时间周期与结构演变',
    description: '26年3月20日 · 第四十五期',
    number: 45,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'bMvC8JYm8PY',
  },
  {
    title: 'TRUMP代币炒作与维加斯通道',
    description: '26年3月20日 · 第四十六期',
    number: 46,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'H8XZhK_v2O4',
  },
  {
    title: '33天，10万刀赚一百四十万刀黄金白银复盘',
    description: '26年3月21日 · 第四十七期',
    number: 47,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'nr4wrPlmfmM',
  },
  {
    title: '金银比测顶与纸黄金买点推演',
    description: '26年3月22日 · 第四十八期',
    number: 48,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'a7_a_Ea8-og',
  },
  {
    title: '黄金恐慌暴跌与泰国停盘见底',
    description: '26年3月23日 · 第四十九期',
    number: 49,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'oaP1hbbSgvA',
  },
  {
    title: '周线开盘价与黄金波段逃顶',
    description: '26年3月25日 · 第五十期',
    number: 50,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'SfM_-AnsVOk',
  },
  {
    title: '黄金短线回抽做空与周线开盘价',
    description: '26年3月26日 · 第五十一期',
    number: 51,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '7QrykhVHeDo',
  },
  {
    title: '黄金大周期梳理与现货底部买点',
    description: '26年3月28日 · 第五十二期',
    number: 52,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'TyMb-kV5uiU',
  },
  {
    title: '美股中期选举规律与英伟达买点',
    description: '26年3月28日 · 第五十三期',
    number: 53,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'Ui5B0T0-U44',
  },
  {
    title: '黄金时间周期复盘与大震荡推演',
    description: '26年3月31日 · 第五十四期',
    number: 54,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'kAia8tRQROo',
  },
  {
    title: '黄金日线级反弹与水上金叉见顶',
    description: '26年4月1日 · 第五十五期',
    number: 55,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'Q08zGqJEBgM',
  },
  {
    title: 'MACD零轴博弈与黄金上轨逃顶',
    description: '26年4月2日 · 第五十六期',
    number: 56,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '1JPpyX9nSwU',
  },
  {
    title: '多周期看盘逻辑与核心指标运用',
    description: '26年4月7日 · 第五十七期',
    number: 57,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'CcwUocpn8do',
  },
  {
    title: '突发消息面博弈与电话预警设置',
    description: '26年4月8日 · 第五十八期',
    number: 58,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'R7ih3O5izEU',
  },
  {
    title: '实战8年的交易员告诉你所有技术分析都相通',
    description: '26年4月10日 · 第五十九期',
    number: 59,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'k6Q8-u3T5zw',
  },

  // ===== 技术指标 (11-20) =====
  {
    title: 'RSI 相对强弱指标',
    description: '深入学习RSI指标的计算原理、超买超卖区域判断、背离信号识别，以及RSI在不同市场环境中的应用策略。',
    category: 'indicator',
    duration: '23:20',
    articleUrl: '/indicators/rsi.html',
    cover: '/covers/ep12-rsi.svg',
  },
  {
    title: 'MACD 指标详解',
    description: '全面解析MACD指标的构成（DIF线、DEA线、柱状图），学习金叉死叉、零轴上下、顶底背离等经典用法。',
    category: 'indicator',
    duration: '25:45',
    articleUrl: '/indicators/macd.html',
    cover: '/covers/ep13-macd.svg',
  },
  {
    title: '布林带策略',
    description: '掌握布林带（Bollinger Bands）的三条线含义，学习布林带收口、开口、突破等形态的交易策略。',
    category: 'indicator',
    duration: '20:10',
    articleUrl: '/indicators/bollinger.html',
    cover: '/covers/ep14-bollinger.svg',
  },
  {
    title: '维加斯通道',
    description: '理解Vegas隧道（EMA144/EMA169）的趋势判断逻辑，学习价格与通道的位置关系、EMA12过滤信号及趋势震荡区分方法。',
    category: 'indicator',
    duration: '19:25',
    articleUrl: '/indicators/vegas.html',
    cover: '/covers/ep-vegas.svg',
  },
  {
    title: '斐波那契回撤',
    description: '深入学习斐波那契数列在技术分析中的应用，掌握0.236、0.382、0.5、0.618等关键回撤位的实战用法。',
    category: 'indicator',
    duration: '22:55',
    articleUrl: '/indicators/fibonacci.html',
    cover: '/covers/ep-fibonacci.svg',
  },
  {
    title: '一目均衡表',
    description: '系统解析一目均衡表（Ichimoku Cloud）的五条线和云层含义，学习云层支撑阻力、延迟线确认等高级用法。',
    category: 'indicator',
    duration: '27:30',
    articleUrl: '/indicators/ichimoku.html',
    cover: '/covers/ep18-ichimoku.svg',
  },
  {
    title: 'OBV 能量潮指标',
    description: '从计算逻辑、市场含义、10 种价量关系到实战用法与背离判断，一次看懂成交量累积动能指标。',
    category: 'indicator',
    duration: '18:00',
    articleUrl: '/indicators/obv.html',
    cover: '/covers/ep-obv.svg',
  },
  {
    title: 'VWAP 成交量加权均价',
    description: '从公式、公允价格、机构成本到 Anchored VWAP 选点逻辑，一次看懂 VWAP 在市场中怎么应用。',
    category: 'indicator',
    duration: '22:00',
    articleUrl: '/indicators/vwap.html',
    cover: '/covers/ep-vwap.svg',
  },
  {
    title: '固定成交量分布图',
    description: '从 POC、VAH、VAL 到区间上沿下沿、突破失衡与选点逻辑，一次看懂 Fixed Range Volume Profile。',
    category: 'indicator',
    duration: '25:00',
    articleUrl: '/indicators/volume-profile.html',
    cover: '/covers/ep-volume-profile.svg',
  },

  // ===== 形态分析 (21-30) =====
  {
    title: '头肩顶与头肩底',
    description: '详细解析头肩顶和头肩底反转形态的构成要素，学习颈线突破的确认方法和目标价位的测算技巧。',
    category: 'pattern',
    duration: '23:50',
    articleUrl: '/patterns/hs.html',
    cover: '/covers/ep-hs.svg',
  },
  {
    title: '双顶与双底形态',
    description: '学习M头和W底形态的识别要点，掌握假突破的过滤方法，理解双重顶底在实战中的可靠性评估。',
    category: 'pattern',
    duration: '19:25',
    articleUrl: '/patterns/double-top-bottom.html',
    cover: '/covers/ep-double-top-bottom.svg',
  },
  {
    title: '三角形态解析',
    description: '全面分析上升三角形、下降三角形和对称三角形的特征，学习三角形突破方向的判断与目标位测算。',
    category: 'pattern',
    duration: '21:00',
    articleUrl: '/patterns/triangle.html',
    cover: '/covers/ep-triangle.svg',
  },
  {
    title: '旗形与楔形',
    description: '掌握旗形和楔形这两种重要的持续形态，学习它们在趋势中继中的确认方法和交易策略。',
    category: 'pattern',
    duration: '17:40',
    articleUrl: '/patterns/flag-wedge.html',
    cover: '/covers/ep-flag-wedge.svg',
  },
  {
    title: '矩形整理形态',
    description: '学习矩形（箱体）整理形态的特征与突破交易策略，掌握箱体内高抛低吸和突破追踪的两种操作方法。',
    category: 'pattern',
    duration: '16:15',
  },
  {
    title: '缺口理论',
    description: '系统分类四种缺口类型（普通缺口、突破缺口、持续缺口、衰竭缺口），学习缺口回补原理与交易策略。',
    category: 'pattern',
    duration: '20:30',
    articleUrl: '/patterns/gap.html',
    cover: '/covers/ep-gap.svg',
  },
  {
    title: '岛形反转',
    description: '学习岛形反转这一强力反转信号的识别方法，理解岛形顶和岛形底的形成机制与交易意义。',
    category: 'pattern',
    duration: '14:20',
  },
  {
    title: '圆弧顶底形态',
    description: '掌握圆弧顶和圆弧底这两种渐进式反转形态的特征，学习其形成过程中的成交量变化规律。',
    category: 'pattern',
    duration: '15:55',
  },
  {
    title: 'V 型反转',
    description: '分析V型反转和倒V型反转的形成条件，学习快速反转行情中的应对策略和风险控制方法。',
    category: 'pattern',
    duration: '13:40',
  },
  {
    title: '复合形态识别',
    description: '学习如何在实盘中识别复合形态（多个基本形态的组合），掌握形态嵌套和形态演变的分析方法。',
    category: 'pattern',
    duration: '24:15',
  },

  // ===== 交易策略 (31-40) =====
  {
    title: '真突破与假突破分辨',
    description: '系统学习如何分辨真突破与假突破：从结构、量能、收盘、回踩、时间、K线形态多维度识别主力陷阱，掌握真突破的入场时机和止损设置。',
    category: 'strategy',
    duration: '26:00',
    articleUrl: '/strategies/breakout-real-vs-fake.html',
    cover: '/covers/ep-breakout.svg',
  },
  // 已下线：回调买入策略（原 id=81，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: '均线交叉系统',
    description: '构建基于均线交叉的完整交易系统，学习双均线、三均线系统的设置方法和信号过滤技巧。',
    category: 'strategy',
    duration: '23:15',
    articleUrl: '/strategies/ma-crossover-system.html',
    cover: '/covers/ep-ma-crossover.svg',
  },
  // 已下线：多时间框架分析（原 id=83，2026-04-24 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // 已下线：量价关系深入（原 id=84，2026-04-24 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: '市场情绪分析',
    description: '学习如何通过恐惧贪婪指数、多空比、资金费率等指标分析市场情绪，将情绪分析融入交易决策。',
    category: 'strategy',
    duration: '18:10',
    articleUrl: '/strategies/market-sentiment.html',
    cover: '/covers/ep-market-sentiment.svg',
  },
  // 已下线：板块轮动策略（原 id=86，2026-04-24 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // 已下线：资金流向分析（原 id=87，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // 已下线：止损策略大全（原 id=88，2026-04-24 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: '仓位管理系统',
    description: '建立科学的仓位管理体系，学习固定比例法、凯利公式、金字塔加仓法等资金管理方法的实战应用。',
    category: 'strategy',
    duration: '24:50',
  },

  // ===== 技术模型 (41-50) =====
  {
    title: 'Smart Money 概念',
    description: '学习Smart Money（聪明钱）的交易逻辑，理解机构交易者如何操纵价格，掌握跟随聪明钱的交易策略。',
    category: 'advanced',
    duration: '26:15',
    articleUrl: '/models/smc.html',
    cover: '/covers/ep48-smc.svg',
  },
  {
    title: 'ICT 交易方法论',
    description: '系统学习ICT（Inner Circle Trader）交易方法论的核心概念，包括OTE、FVG、Breaker Block等高级工具。',
    category: 'advanced',
    duration: '29:00',
    articleUrl: '/models/ict.html',
    cover: '/covers/ep49-ict.svg',
  },
  {
    title: '威科夫理论',
    description: '深入学习威科夫（Wyckoff）方法的四个阶段：积累、上涨、派发、下跌，掌握威科夫事件与测试的判断。',
    category: 'advanced',
    duration: '27:20',
    articleUrl: '/models/wyckoff.html',
    cover: '/covers/ep50-wyckoff.svg',
  },
  {
    title: '艾略特波浪理论（一）',
    description: '系统学习艾略特波浪理论的基本原理，掌握5浪推动和3浪调整的基本结构，理解各浪的特征与规则。',
    category: 'advanced',
    duration: '28:30',
    articleUrl: '/models/elliott-wave-1.html',
    cover: '/covers/ep-elliott1.svg',
  },
  // 原艾略特波浪理论（二）位置，现替换为缠论（保持 episode_id = 94 稳定）
  {
    title: '缠论 · 缠中说缠',
    description: '系统学习缠论的核心概念：笔、线段、中枢、买卖点、背驰。从分型识别到三类买卖点实战，掌握缠中说缠体系。',
    category: 'advanced',
    duration: '30:00',
    articleUrl: '/models/chanlun.html',
    cover: '/covers/ep-chanlun.svg',
  },
  {
    title: '谐波形态交易',
    description: '学习Gartley、Bat、Butterfly、Crab等经典谐波形态的识别方法，掌握谐波交易的入场和目标设定。',
    category: 'advanced',
    duration: '25:20',
    articleUrl: '/models/harmonic.html',
    cover: '/covers/ep-harmonic.svg',
  },
  // 已下线：供需区域分析（原 id=96，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: '订单流分析入门',
    description: '初步了解订单流（Order Flow）的概念，学习通过买卖盘口、成交分布判断短期价格走向的方法。',
    category: 'advanced',
    duration: '21:55',
    articleUrl: '/models/order-flow.html',
    cover: '/covers/ep-order-flow.svg',
  },
  // 已下线：市场结构理论（原 id=98，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // 已下线：流动性概念（原 id=99，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },

  // ===== 实战应用 (51-59) =====
  // 已下线：加密货币技术分析（原 id=100，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // 已下线：外汇市场实战（原 id=101，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // 已下线：美股技术分析（原 id=102，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: '交易系统搭建',
    description: '手把手教你搭建完整的交易系统，从信号产生、入场规则、仓位管理到出场策略的全流程设计。',
    category: 'strategy',
    duration: '28:15',
  },
  // 已下线：回测与优化（原 id=104，2026-04-20 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: '交易心理学',
    description: '深入探讨交易心理对决策的影响，学习克服恐惧、贪婪、过度自信等心理陷阱的实用方法。',
    category: 'strategy',
    duration: '19:30',
    articleUrl: '/strategies/trading-psychology.html',
    cover: '/covers/ep-trading-psychology.svg',
  },
  {
    title: '实盘案例分析（一）',
    description: '通过真实市场案例，综合运用前面学到的技术分析工具，演示从分析到交易的完整决策过程。',
    category: 'strategy',
    duration: '30:20',
  },
  {
    title: '实盘案例分析（二）',
    description: '继续通过实盘案例学习，重点分析失败交易案例，总结常见错误并提炼改进方法。',
    category: 'strategy',
    duration: '28:45',
  },
  // 已下线：技术分析总结与展望（原 id=108，2026-04-24 移除）
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },

  // ===== 第61期 会员专属 =====
  {
    title: '比特币等待下周出现水下两个绿柱再看，黄金继续等盘面清晰，目前市场消息面博弈太多，等行情回归正常',
    description: '26年4月14日 · 第六十一期',
    number: 61,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第62期 会员专属 =====
  {
    title: '26年4月19日黄金白银比特币下周思路',
    description: '26年4月19日 · 第六十二期',
    number: 62,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第63期 会员专属 =====
  {
    title: '比特币思路更新',
    description: '26年4月22日 · 第六十三期',
    number: 63,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第64期 会员专属 =====
  {
    title: '黄金思路更新',
    description: '26年4月22日 · 第六十四期',
    number: 64,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第65期 会员专属 =====
  {
    title: '黄金比特币更新',
    description: '26年4月23日 · 第六十五期 · 仔细讲了黄金大方向的区间',
    number: 65,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第66期 会员专属 =====
  {
    title: '黄金周末思路',
    description: '26年4月24日 · 第六十六期',
    number: 66,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第67期 会员专属 =====
  {
    title: '比特币黄金最新思路',
    description: '26年4月28日 · 第六十七期',
    number: 67,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第68期 会员专属 =====
  {
    title: '5月8日黄金思路更新',
    description: '26年5月8日 · 第六十八期',
    number: 68,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第69期 会员专属 =====
  {
    title: '黄金美股比特币思路',
    description: '26年5月13日 · 第六十九期',
    number: 69,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第70期 会员专属 =====
  {
    title: '黄金思路更新',
    description: '26年5月15日 · 第七十期',
    number: 70,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第71期 会员专属 =====
  {
    title: '黄金性价比买入点位更新',
    description: '26年5月15日 · 第七十一期',
    number: 71,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第72期 会员专属 =====
  {
    title: '比特币思路更新',
    description: '26年5月16日 · 第七十二期',
    number: 72,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第73期 会员专属 =====
  {
    title: '黄金，比特币，美股思路。',
    description: '26年5月18日 · 第七十三期',
    number: 73,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第74期 会员专属 =====
  {
    title: '黄金思路更新',
    description: '26年5月20日 · 第七十四期',
    number: 74,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第75期 会员专属 =====
  {
    title: '回答社区的一些问题，简单聊聊',
    description: '26年5月24日 · 第七十五期',
    number: 75,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== 第76期 登录可看 =====
  {
    title: '一个月内我如何使用ai抓到了涨幅很高的股票',
    description: '26年5月27日 · 第七十六期',
    number: 76,
    category: 'indicator',
    duration: '',
    youtubeId: 'AzqaGZyI9Cg',
    accessLevel: 'logged_in',
  },

  // ===== 第77期 会员专属 =====
  {
    title: '行情思路分享，定时更新',
    description: '26年5月29日 · 第七十七期',
    number: 77,
    category: 'indicator',
    duration: '20:00',
    accessLevel: 'plus_pro',
  },
]

// 构建完整课程数据
// 1. ep.number 硬编码的优先（如第60期），不计入自动计数
// 2. 有 youtubeId 的早盘解读按顺序自动递增编号
// 3. 非视频内容（技术指标/形态分析/交易策略/技术模型）不编号，number = 0
let _videoCounter = 0
export const episodes = episodeRaw.map((ep, i) => {
  let number
  if (ep.number) {
    number = ep.number
  } else if (ep.youtubeId) {
    _videoCounter++
    number = _videoCounter
  } else {
    number = 0
  }
  const id = i + 1
  return {
    id,
    number,
    title: ep.title,
    description: ep.description,
    category: ep.youtubeId ? 'morning' : ep.category,
    contentType: ep.articleUrl ? 'article' : 'video',
    duration: ep.duration,
    youtubeId: ep.youtubeId || '',
    cover: ep.cover || '',
    gradient: gradients[i % gradients.length],
    articleUrl: ep.articleUrl || '',
    accessLevel: ep.accessLevel || 'free',
  }
})
