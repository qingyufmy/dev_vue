// è¯¾ç¨åç±»
export const categories = [
  { id: 'all', name: 'è§é¢è¯¾ç¨' },
  { id: 'indicator', name: 'ææ¯ææ ' },
  { id: 'pattern', name: 'å½¢æåæ' },
  { id: 'strategy', name: 'äº¤æç­ç¥' },
  { id: 'advanced', name: 'ææ¯æ¨¡å' },
]

// å¡çæ¸åèæ¯è²
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

// 60æè¯¾ç¨æ°æ®
const episodeRaw = [
  // ===== åºç¡å¥é¨ (1-10) =====
  {
    title: 'è£¸Käº¤æä¸ç©¿å¤´ç ´èåçªç ´',
    description: '25å¹´10æ11æ¥ Â· ç¬¬ä¸æ',
    category: 'indicator',
    duration: '18:30',
    youtubeId: '05JRtvPsk-M',
    cover: '/covers/ep01.webp',
  },
  {
    title: 'æ´è·é¿éå¤çä¸ææçå¤ç­ç¥',
    description: '25å¹´10æ12æ¥ Â· ç¬¬äºæ',
    category: 'indicator',
    duration: '22:15',
    youtubeId: 'Bw8rDLGGA_w',
    cover: '/covers/ep02.webp',
  },
  {
    title: 'åçº¿åç©ºä¸çå¤ç©ºé»è¾åå¼',
    description: '25å¹´10æ23æ¥ Â· ç¬¬ä¸æ',
    category: 'indicator',
    duration: '19:45',
    youtubeId: 'aJA3vIda0wg',
    cover: '/covers/ep03.webp',
  },
  {
    title: 'é»éæ´è·æåºä¸è¿ç¦»å¸å®åçº¦',
    description: '25å¹´10æ28æ¥ Â· ç¬¬åæ',
    category: 'indicator',
    duration: '16:20',
    youtubeId: 'bgyGzldmVJo',
    cover: '/covers/ep04.webp',
  },
  {
    title: 'éæ¯åè¡ææ¨æ¼åé»éé¡¶èç¦»',
    description: '25å¹´10æ29æ¥ Â· ç¬¬äºæ',
    category: 'indicator',
    duration: '22:30',
    youtubeId: 'iNuXmPh0oUY',
    cover: '/covers/ep05.webp',
  },
  {
    title: 'åçº¿ç¼ ç»éè¡ä¸é²èä¸è·æ©å¤§',
    description: '25å¹´11æ1æ¥ Â· ç¬¬å­æ',
    category: 'indicator',
    duration: '20:30',
    youtubeId: '1EE5hOJiarA',
    cover: '/covers/ep06.webp',
  },
  {
    title: 'çå¸æ°´ä¸éåè§é¡¶ä¸é»éåç©º',
    description: '25å¹´11æ11æ¥ Â· ç¬¬ä¸æ',
    category: 'indicator',
    duration: '17:55',
    youtubeId: 'xNciWvo-Fpw',
    cover: '/covers/ep07.webp',
  },
  {
    title: 'åçº¿ç©ºå¤´æåä¸é»éèç¦»åç©º',
    description: '25å¹´11æ15æ¥ Â· ç¬¬å«æ',
    category: 'indicator',
    duration: '21:40',
    youtubeId: 'mTvpUp-wECw',
    cover: '/covers/ep08.webp',
  },
  {
    title: 'åºé´é»ååç©ºä¸é»éVWAPåºç¨',
    description: '25å¹´11æ17æ¥ Â· ç¬¬ä¹æ',
    category: 'indicator',
    duration: '14:50',
    youtubeId: '6JwjOrSpjkY',
    cover: '/covers/ep09.webp',
  },

  {
    title: 'BTCæ¥çº¿éåä¸VWAPæ³¢æ®µåç©º',
    description: '25å¹´11æ29æ¥ Â· ç¬¬åä¸æ',
    number: 11,
    category: 'indicator',
    duration: '19:15',
    youtubeId: '-cRNwXrmMQE',
    cover: '/covers/ep10.webp',
  },

  {
    title: 'éå¤´äºæ¢é¢æä¸æçº¿æ­»åæ¨æ¼',
    description: '25å¹´12æ1æ¥ Â· ç¬¬åäºæ',
    number: 12,
    category: 'indicator',
    duration: '20:00',
    youtubeId: 'hCnLfx-y8A8',
    cover: '/covers/ep11.webp',
  },

  // ===== ç¬¬60æ ä¼åä¸å±ï¼number: 60 ç¡¬ç¼ç ï¼ä¸å¯æ´æ¹ï¼=====
  {
    title: 'é»éå»5000ä¹åè½å¦åºç°ä¸æ¬¡ç»ä½³çä¹°ç¹ï¼ç»å"åè°å½¢æ"ä¸åå²å¨æå¯»æ¾æºä¼',
    description: '26å¹´4æ12æ¥ Â· ç¬¬å­åæ',
    number: 60,
    category: 'indicator',
    duration: '20:00',
    cover: '/covers/ep60.webp',
  },

  {
    title: 'é»éèµ°å¼±ä¸ç­¹ç å¯éåºåç©º',
    description: '25å¹´12æ2æ¥ Â· ç¬¬åä¸æ',
    number: 13,
    category: 'indicator',
    duration: '20:00',
    youtubeId: 'KUtjKpM2VEc',
    cover: '/covers/ep12.webp',
  },

  {
    title: 'BTCè§¦åå³é®æ¯æä¸ç°è´§å»ºä»',
    description: '25å¹´11æ22æ¥ Â· ç¬¬åæ',
    number: 10,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'upwxoQYCdQw',
  },

  // ===== EP.14-59 è§é¢è¯¾ç¨ =====
  {
    title: 'VWAPå®ææå­¦ä¸è¿ç»­æµè¯ç ´ä½',
    description: '25å¹´12æ6æ¥ Â· ç¬¬ååæ',
    number: 14,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '_kcWH_97qGs',
  },
  {
    title: 'éæ¯ååæ¨æ¼ä¸é²èæ¥æ¬å æ¯',
    description: '25å¹´12æ6æ¥ Â· ç¬¬åäºæ',
    number: 15,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '50k1unD6aJo',
  },
  {
    title: 'BTCååå¤´è©é¡¶ä¸ç»é¨è¡æ',
    description: '25å¹´12æ10æ¥ Â· ç¬¬åå­æ',
    number: 16,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'PeaeeybYf7U',
  },
  {
    title: 'éæ¯è½å°èµ°å¼±ä¸å³é®èç¹æ­¢æ',
    description: '25å¹´12æ11æ¥ Â· ç¬¬åä¸æ',
    number: 17,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'T4QoVadshQA',
  },
  {
    title: 'é»éç­çº¿æ³¢æ®µä¸è¶å¿åçææ©',
    description: '25å¹´12æ14æ¥ Â· ç¬¬åå«æ',
    number: 18,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'vwpsktcpQbU',
  },
  {
    title: 'éè¡æ«æç­¹ç åå¸ä¸è¶å¿çº¿çªç ´',
    description: '25å¹´12æ20æ¥ Â· ç¬¬åä¹æ',
    number: 19,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'KvEYkz6JX_Y',
  },
  {
    title: 'ä¼¦æ¦éå®çæ¶é´ä¸æç°è´§å¯¹æ¯',
    description: '25å¹´12æ24æ¥ Â· ç¬¬äºåæ',
    number: 20,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'RQsnLznebAA',
  },
  {
    title: 'ç½é¶æ¸é¡¶åç©ºä¸CMEå¾è¡¨è¿ç¨',
    description: '26å¹´1æ3æ¥ Â· ç¬¬äºåä¸æ',
    number: 21,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'zQJj78UJjzk',
  },
  {
    title: 'BTCéè¡çªç ´ä¸æäº¤éåå¸å¾',
    description: '26å¹´1æ4æ¥ Â· ç¬¬äºåäºæ',
    number: 22,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'n5f9frnqGTQ',
  },
  {
    title: 'é»åæ¯æè½¬æ¢ä¸å¾®ç­ç¥é»è¾åå¼',
    description: '26å¹´1æ15æ¥ Â· ç¬¬äºåä¸æ',
    number: 23,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'f01PWI3LWV8',
  },
  {
    title: '1æ1æ¥å¹´çº¿å¼çä»·å®æè¿ç¨',
    description: '26å¹´1æ15æ¥ Â· ç¬¬äºååæ',
    number: 24,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'ULpNVjSHols',
  },
  {
    title: 'å¹´çº¿ä¸å¨æå¼çä»·ææ æ·±åº¦è§£æ',
    description: '26å¹´1æ16æ¥ Â· ç¬¬äºåäºæ',
    number: 25,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'WDRRZ0CLJuM',
  },
  {
    title: 'ç½é¶ç®±ä½åçªç ´ä¸æ¸é¡¶åç©ºé»è¾',
    description: '26å¹´1æ30æ¥ Â· ç¬¬äºåå­æ',
    number: 26,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'TTPvhHGzRmw',
  },
  {
    title: 'åå²éé¶æ¯æµç®ä¸ç½é¶å¤§é¡¶ç¡®è®¤',
    description: '26å¹´1æ31æ¥ Â· ç¬¬äºåä¸æ',
    number: 27,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'uZ9cuLcGpzg',
  },
  {
    title: 'å»è22å¹´ç ´ä½èµ°å¿ä¸çå¸åç©º',
    description: '26å¹´2æ2æ¥ Â· ç¬¬äºåå«æ',
    number: 28,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'lh52KWI-QdI',
  },
  {
    title: 'äº¤æçº§å«çå¤å®ä¸å¤ç©ºæ³¢æ®µæä½',
    description: '26å¹´2æ3æ¥ Â· ç¬¬äºåä¹æ',
    number: 29,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'GNMJeMr1CGg',
  },
  {
    title: 'ç½é¶åè·ç ´ä¸æåºä¼éé»éé»è¾',
    description: '26å¹´2æ5æ¥ Â· ç¬¬ä¸åæ',
    number: 30,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'k6VK0wYHrrM',
  },
  {
    title: 'BTCåå¹´å¨æéæ¼ä¸é²èåçº¦',
    description: '26å¹´2æ6æ¥ Â· ç¬¬ä¸åä¸æ',
    number: 31,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '_TwGHZFqXPc',
  },
  {
    title: 'é¡ºåºä¸»è·è¶å¿ä¸é²èéå¿æåº',
    description: '26å¹´2æ8æ¥ Â· ç¬¬ä¸åäºæ',
    number: 32,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'FGItTZtniGo',
  },
  {
    title: 'æ¥çº¿åå­çº¿ç»æä¸å®æè¿ç¨',
    description: '26å¹´2æ11æ¥ Â· ç¬¬ä¸åä¸æ',
    number: 33,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'ctCfb8goImM',
  },
  {
    title: 'ç½é¶ç²¾åæµé¡¶ä¸BTCç©¿å¤´ç ´è',
    description: '26å¹´2æ22æ¥ Â· ç¬¬ä¸ååæ',
    number: 34,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'kr_-77TRsUM',
  },
  {
    title: 'ä¸»åæµªæ´è·ä¸æ¬¡é«ç¹åå¼¹åå¼',
    description: '26å¹´2æ24æ¥ Â· ç¬¬ä¸åäºæ',
    number: 35,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'V2cq_gVWQ2k',
  },
  {
    title: 'å»èæ±åçæ¬è´¨ä¸è·¨åç§è¿ç¨',
    description: '26å¹´2æ24æ¥ Â· ç¬¬ä¸åå­æ',
    number: 36,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'zmMoghLXfdw',
  },
  {
    title: 'è£¸Kå®ä½æ¯æä¸é«çäºæ¯å¥åº',
    description: '26å¹´2æ25æ¥ Â· ç¬¬ä¸åä¸æ',
    number: 37,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '5BxxTsTLIgM',
  },
  {
    title: 'é»éç­çº¿åè¸©ä¸ç®æ ä½æ¨æ¼',
    description: '26å¹´2æ25æ¥ Â· ç¬¬ä¸åå«æ',
    number: 38,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'eEj7EU56m7s',
  },
  {
    title: 'æç«æ¶æ¯é¢åå¼ä¸å¨æ«æµå¨æ§',
    description: '26å¹´3æ1æ¥ Â· ç¬¬ä¸åä¹æ',
    number: 39,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'aqC1fGwDmd0',
  },
  {
    title: 'çåçªç ´å¤å®ä¸ææ³¢é£å¥ç»æ³',
    description: '26å¹´3æ3æ¥ Â· ç¬¬ååæ',
    number: 40,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'KQajssH5pk8',
  },
  {
    title: 'TRUMPä»£å¸æå®´é»è¾ä¸å¤ç',
    description: '26å¹´3æ13æ¥ Â· ç¬¬ååä¸æ',
    number: 41,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'homEzMa7EPQ',
  },
  {
    title: 'BTCé¿ä¸å½±çº¿ä¸å¨çº¿MACDæ­»å·®',
    description: '26å¹´3æ16æ¥ Â· ç¬¬ååäºæ',
    number: 42,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'JYjuwkttfUI',
  },
  {
    title: 'éé¶åçªç ´ä¸ç½é¶è§é¡¶æ¨æ¼',
    description: '26å¹´3æ18æ¥ Â· ç¬¬ååä¸æ',
    number: 43,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'N57PjhHNx10',
  },
  {
    title: 'é»éæ´è·æµåºä¸RSIè¶åä¿®å¤',
    description: '26å¹´3æ20æ¥ Â· ç¬¬åååæ',
    number: 44,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'SzLPFV5JEvE',
  },
  {
    title: 'BTCçå¸æ¶é´å¨æä¸ç»ææ¼å',
    description: '26å¹´3æ20æ¥ Â· ç¬¬ååäºæ',
    number: 45,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'bMvC8JYm8PY',
  },
  {
    title: 'TRUMPä»£å¸çä½ä¸ç»´å æ¯éé',
    description: '26å¹´3æ20æ¥ Â· ç¬¬ååå­æ',
    number: 46,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'H8XZhK_v2O4',
  },
  {
    title: '33å¤©ï¼10ä¸åèµä¸ç¾ååä¸åé»éç½é¶å¤ç',
    description: '26å¹´3æ21æ¥ Â· ç¬¬ååä¸æ',
    number: 47,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'nr4wrPlmfmM',
  },
  {
    title: 'éé¶æ¯æµé¡¶ä¸çº¸é»éä¹°ç¹æ¨æ¼',
    description: '26å¹´3æ22æ¥ Â· ç¬¬ååå«æ',
    number: 48,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'a7_a_Ea8-og',
  },
  {
    title: 'é»éæææ´è·ä¸æ³°å½åçè§åº',
    description: '26å¹´3æ23æ¥ Â· ç¬¬ååä¹æ',
    number: 49,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'oaP1hbbSgvA',
  },
  {
    title: 'å¨çº¿å¼çä»·ä¸é»éæ³¢æ®µéé¡¶',
    description: '26å¹´3æ25æ¥ Â· ç¬¬äºåæ',
    number: 50,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'SfM_-AnsVOk',
  },
  {
    title: 'é»éç­çº¿åæ½åç©ºä¸å¨çº¿å¼çä»·',
    description: '26å¹´3æ26æ¥ Â· ç¬¬äºåä¸æ',
    number: 51,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '7QrykhVHeDo',
  },
  {
    title: 'é»éå¤§å¨ææ¢³çä¸ç°è´§åºé¨ä¹°ç¹',
    description: '26å¹´3æ28æ¥ Â· ç¬¬äºåäºæ',
    number: 52,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'TyMb-kV5uiU',
  },
  {
    title: 'ç¾è¡ä¸­æéä¸¾è§å¾ä¸è±ä¼è¾¾ä¹°ç¹',
    description: '26å¹´3æ28æ¥ Â· ç¬¬äºåä¸æ',
    number: 53,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'Ui5B0T0-U44',
  },
  {
    title: 'é»éæ¶é´å¨æå¤çä¸å¤§éè¡æ¨æ¼',
    description: '26å¹´3æ31æ¥ Â· ç¬¬äºååæ',
    number: 54,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'kAia8tRQROo',
  },
  {
    title: 'é»éæ¥çº¿çº§åå¼¹ä¸æ°´ä¸éåè§é¡¶',
    description: '26å¹´4æ1æ¥ Â· ç¬¬äºåäºæ',
    number: 55,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'Q08zGqJEBgM',
  },
  {
    title: 'MACDé¶è½´åå¼ä¸é»éä¸è½¨éé¡¶',
    description: '26å¹´4æ2æ¥ Â· ç¬¬äºåå­æ',
    number: 56,
    category: 'strategy',
    duration: '20:00',
    youtubeId: '1JPpyX9nSwU',
  },
  {
    title: 'å¤å¨æççé»è¾ä¸æ ¸å¿ææ è¿ç¨',
    description: '26å¹´4æ7æ¥ Â· ç¬¬äºåä¸æ',
    number: 57,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'CcwUocpn8do',
  },
  {
    title: 'çªåæ¶æ¯é¢åå¼ä¸çµè¯é¢è­¦è®¾ç½®',
    description: '26å¹´4æ8æ¥ Â· ç¬¬äºåå«æ',
    number: 58,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'R7ih3O5izEU',
  },
  {
    title: 'å®æ8å¹´çäº¤æååè¯ä½ ææææ¯åæé½ç¸é',
    description: '26å¹´4æ10æ¥ Â· ç¬¬äºåä¹æ',
    number: 59,
    category: 'strategy',
    duration: '20:00',
    youtubeId: 'k6Q8-u3T5zw',
  },

  // ===== ææ¯ææ  (11-20) =====
  {
    title: 'RSI ç¸å¯¹å¼ºå¼±ææ ',
    description: 'æ·±å¥å­¦ä¹ RSIææ çè®¡ç®åçãè¶ä¹°è¶ååºåå¤æ­ãèç¦»ä¿¡å·è¯å«ï¼ä»¥åRSIå¨ä¸åå¸åºç¯å¢ä¸­çåºç¨ç­ç¥ã',
    category: 'indicator',
    duration: '23:20',
    articleUrl: '/indicators/rsi.html',
    cover: '/covers/ep12-rsi.svg',
  },
  {
    title: 'MACD ææ è¯¦è§£',
    description: 'å¨é¢è§£æMACDææ çææï¼DIFçº¿ãDEAçº¿ãæ±ç¶å¾ï¼ï¼å­¦ä¹ éåæ­»åãé¶è½´ä¸ä¸ãé¡¶åºèç¦»ç­ç»å¸ç¨æ³ã',
    category: 'indicator',
    duration: '25:45',
    articleUrl: '/indicators/macd.html',
    cover: '/covers/ep13-macd.svg',
  },
  {
    title: 'å¸æå¸¦ç­ç¥',
    description: 'ææ¡å¸æå¸¦ï¼Bollinger Bandsï¼çä¸æ¡çº¿å«ä¹ï¼å­¦ä¹ å¸æå¸¦æ¶å£ãå¼å£ãçªç ´ç­å½¢æçäº¤æç­ç¥ã',
    category: 'indicator',
    duration: '20:10',
    articleUrl: '/indicators/bollinger.html',
    cover: '/covers/ep14-bollinger.svg',
  },
  {
    title: 'ç»´å æ¯éé',
    description: 'çè§£Vegasé§éï¼EMA144/EMA169ï¼çè¶å¿å¤æ­é»è¾ï¼å­¦ä¹ ä»·æ ¼ä¸ééçä½ç½®å³ç³»ãEMA12è¿æ»¤ä¿¡å·åè¶å¿éè¡åºåæ¹æ³ã',
    category: 'indicator',
    duration: '19:25',
    articleUrl: '/indicators/vegas.html',
    cover: '/covers/ep-vegas.svg',
  },
  {
    title: 'ææ³¢é£å¥åæ¤',
    description: 'æ·±å¥å­¦ä¹ ææ³¢é£å¥æ°åå¨ææ¯åæä¸­çåºç¨ï¼ææ¡0.236ã0.382ã0.5ã0.618ç­å³é®åæ¤ä½çå®æç¨æ³ã',
    category: 'indicator',
    duration: '22:55',
    articleUrl: '/indicators/fibonacci.html',
    cover: '/covers/ep-fibonacci.svg',
  },
  {
    title: 'ä¸ç®åè¡¡è¡¨',
    description: 'ç³»ç»è§£æä¸ç®åè¡¡è¡¨ï¼Ichimoku Cloudï¼çäºæ¡çº¿åäºå±å«ä¹ï¼å­¦ä¹ äºå±æ¯æé»åãå»¶è¿çº¿ç¡®è®¤ç­é«çº§ç¨æ³ã',
    category: 'indicator',
    duration: '27:30',
    articleUrl: '/indicators/ichimoku.html',
    cover: '/covers/ep18-ichimoku.svg',
  },
  {
    title: 'OBV è½éæ½®ææ ',
    description: 'ä»è®¡ç®é»è¾ãå¸åºå«ä¹ã10 ç§ä»·éå³ç³»å°å®æç¨æ³ä¸èç¦»å¤æ­ï¼ä¸æ¬¡çææäº¤éç´¯ç§¯å¨è½ææ ã',
    category: 'indicator',
    duration: '18:00',
    articleUrl: '/indicators/obv.html',
    cover: '/covers/ep-obv.svg',
  },
  {
    title: 'VWAP æäº¤éå æåä»·',
    description: 'ä»å¬å¼ãå¬åä»·æ ¼ãæºæææ¬å° Anchored VWAP éç¹é»è¾ï¼ä¸æ¬¡çæ VWAP å¨å¸åºä¸­æä¹åºç¨ã',
    category: 'indicator',
    duration: '22:00',
    articleUrl: '/indicators/vwap.html',
    cover: '/covers/ep-vwap.svg',
  },
  {
    title: 'åºå®æäº¤éåå¸å¾',
    description: 'ä» POCãVAHãVAL å°åºé´ä¸æ²¿ä¸æ²¿ãçªç ´å¤±è¡¡ä¸éç¹é»è¾ï¼ä¸æ¬¡çæ Fixed Range Volume Profileã',
    category: 'indicator',
    duration: '25:00',
    articleUrl: '/indicators/volume-profile.html',
    cover: '/covers/ep-volume-profile.svg',
  },

  // ===== å½¢æåæ (21-30) =====
  {
    title: 'å¤´è©é¡¶ä¸å¤´è©åº',
    description: 'è¯¦ç»è§£æå¤´è©é¡¶åå¤´è©åºåè½¬å½¢æçææè¦ç´ ï¼å­¦ä¹ é¢çº¿çªç ´çç¡®è®¤æ¹æ³åç®æ ä»·ä½çæµç®æå·§ã',
    category: 'pattern',
    duration: '23:50',
    articleUrl: '/patterns/hs.html',
    cover: '/covers/ep-hs.svg',
  },
  {
    title: 'åé¡¶ä¸ååºå½¢æ',
    description: 'å­¦ä¹ Må¤´åWåºå½¢æçè¯å«è¦ç¹ï¼ææ¡åçªç ´çè¿æ»¤æ¹æ³ï¼çè§£åéé¡¶åºå¨å®æä¸­çå¯é æ§è¯ä¼°ã',
    category: 'pattern',
    duration: '19:25',
    articleUrl: '/patterns/double-top-bottom.html',
    cover: '/covers/ep-double-top-bottom.svg',
  },
  {
    title: 'ä¸è§å½¢æè§£æ',
    description: 'å¨é¢åæä¸åä¸è§å½¢ãä¸éä¸è§å½¢åå¯¹ç§°ä¸è§å½¢çç¹å¾ï¼å­¦ä¹ ä¸è§å½¢çªç ´æ¹åçå¤æ­ä¸ç®æ ä½æµç®ã',
    category: 'pattern',
    duration: '21:00',
    articleUrl: '/patterns/triangle.html',
    cover: '/covers/ep-triangle.svg',
  },
  {
    title: 'æå½¢ä¸æ¥å½¢',
    description: 'ææ¡æå½¢åæ¥å½¢è¿ä¸¤ç§éè¦çæç»­å½¢æï¼å­¦ä¹ å®ä»¬å¨è¶å¿ä¸­ç»§ä¸­çç¡®è®¤æ¹æ³åäº¤æç­ç¥ã',
    category: 'pattern',
    duration: '17:40',
    articleUrl: '/patterns/flag-wedge.html',
    cover: '/covers/ep-flag-wedge.svg',
  },
  {
    title: 'ç©å½¢æ´çå½¢æ',
    description: 'å­¦ä¹ ç©å½¢ï¼ç®±ä½ï¼æ´çå½¢æçç¹å¾ä¸çªç ´äº¤æç­ç¥ï¼ææ¡ç®±ä½åé«æä½å¸åçªç ´è¿½è¸ªçä¸¤ç§æä½æ¹æ³ã',
    category: 'pattern',
    duration: '16:15',
  },
  {
    title: 'ç¼ºå£çè®º',
    description: 'ç³»ç»åç±»åç§ç¼ºå£ç±»åï¼æ®éç¼ºå£ãçªç ´ç¼ºå£ãæç»­ç¼ºå£ãè¡°ç«­ç¼ºå£ï¼ï¼å­¦ä¹ ç¼ºå£åè¡¥åçä¸äº¤æç­ç¥ã',
    category: 'pattern',
    duration: '20:30',
    articleUrl: '/patterns/gap.html',
    cover: '/covers/ep-gap.svg',
  },
  {
    title: 'å²å½¢åè½¬',
    description: 'å­¦ä¹ å²å½¢åè½¬è¿ä¸å¼ºååè½¬ä¿¡å·çè¯å«æ¹æ³ï¼çè§£å²å½¢é¡¶åå²å½¢åºçå½¢ææºå¶ä¸äº¤ææä¹ã',
    category: 'pattern',
    duration: '14:20',
  },
  {
    title: 'åå¼§é¡¶åºå½¢æ',
    description: 'ææ¡åå¼§é¡¶ååå¼§åºè¿ä¸¤ç§æ¸è¿å¼åè½¬å½¢æçç¹å¾ï¼å­¦ä¹ å¶å½¢æè¿ç¨ä¸­çæäº¤éååè§å¾ã',
    category: 'pattern',
    duration: '15:55',
  },
  {
    title: 'V ååè½¬',
    description: 'åæVååè½¬ååVååè½¬çå½¢ææ¡ä»¶ï¼å­¦ä¹ å¿«éåè½¬è¡æä¸­çåºå¯¹ç­ç¥åé£é©æ§å¶æ¹æ³ã',
    category: 'pattern',
    duration: '13:40',
  },
  {
    title: 'å¤åå½¢æè¯å«',
    description: 'å­¦ä¹ å¦ä½å¨å®çä¸­è¯å«å¤åå½¢æï¼å¤ä¸ªåºæ¬å½¢æçç»åï¼ï¼ææ¡å½¢æåµå¥åå½¢ææ¼åçåææ¹æ³ã',
    category: 'pattern',
    duration: '24:15',
  },

  // ===== äº¤æç­ç¥ (31-40) =====
  {
    title: 'ççªç ´ä¸åçªç ´åè¾¨',
    description: 'ç³»ç»å­¦ä¹ å¦ä½åè¾¨ççªç ´ä¸åçªç ´ï¼ä»ç»æãéè½ãæ¶çãåè¸©ãæ¶é´ãKçº¿å½¢æå¤ç»´åº¦è¯å«ä¸»åé·é±ï¼ææ¡ççªç ´çå¥åºæ¶æºåæ­¢æè®¾ç½®ã',
    category: 'strategy',
    duration: '26:00',
    articleUrl: '/strategies/breakout-real-vs-fake.html',
    cover: '/covers/ep-breakout.svg',
  },
  // å·²ä¸çº¿ï¼åè°ä¹°å¥ç­ç¥ï¼å id=81ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: 'åçº¿äº¤åç³»ç»',
    description: 'æå»ºåºäºåçº¿äº¤åçå®æ´äº¤æç³»ç»ï¼å­¦ä¹ ååçº¿ãä¸åçº¿ç³»ç»çè®¾ç½®æ¹æ³åä¿¡å·è¿æ»¤æå·§ã',
    category: 'strategy',
    duration: '23:15',
    articleUrl: '/strategies/ma-crossover-system.html',
    cover: '/covers/ep-ma-crossover.svg',
  },
  // å·²ä¸çº¿ï¼å¤æ¶é´æ¡æ¶åæï¼å id=83ï¼2026-04-24 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // å·²ä¸çº¿ï¼éä»·å³ç³»æ·±å¥ï¼å id=84ï¼2026-04-24 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: 'å¸åºæç»ªåæ',
    description: 'å­¦ä¹ å¦ä½éè¿ææ§è´ªå©ªææ°ãå¤ç©ºæ¯ãèµéè´¹çç­ææ åæå¸åºæç»ªï¼å°æç»ªåæèå¥äº¤æå³ç­ã',
    category: 'strategy',
    duration: '18:10',
    articleUrl: '/strategies/market-sentiment.html',
    cover: '/covers/ep-market-sentiment.svg',
  },
  // å·²ä¸çº¿ï¼æ¿åè½®å¨ç­ç¥ï¼å id=86ï¼2026-04-24 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // å·²ä¸çº¿ï¼èµéæµååæï¼å id=87ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // å·²ä¸çº¿ï¼æ­¢æç­ç¥å¤§å¨ï¼å id=88ï¼2026-04-24 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: 'ä»ä½ç®¡çç³»ç»',
    description: 'å»ºç«ç§å­¦çä»ä½ç®¡çä½ç³»ï¼å­¦ä¹ åºå®æ¯ä¾æ³ãå¯å©å¬å¼ãéå­å¡å ä»æ³ç­èµéç®¡çæ¹æ³çå®æåºç¨ã',
    category: 'strategy',
    duration: '24:50',
  },

  // ===== ææ¯æ¨¡å (41-50) =====
  {
    title: 'Smart Money æ¦å¿µ',
    description: 'å­¦ä¹ Smart Moneyï¼èªæé±ï¼çäº¤æé»è¾ï¼çè§£æºæäº¤æèå¦ä½æçºµä»·æ ¼ï¼ææ¡è·éèªæé±çäº¤æç­ç¥ã',
    category: 'advanced',
    duration: '26:15',
    articleUrl: '/models/smc.html',
    cover: '/covers/ep48-smc.svg',
  },
  {
    title: 'ICT äº¤ææ¹æ³è®º',
    description: 'ç³»ç»å­¦ä¹ ICTï¼Inner Circle Traderï¼äº¤ææ¹æ³è®ºçæ ¸å¿æ¦å¿µï¼åæ¬OTEãFVGãBreaker Blockç­é«çº§å·¥å·ã',
    category: 'advanced',
    duration: '29:00',
    articleUrl: '/models/ict.html',
    cover: '/covers/ep49-ict.svg',
  },
  {
    title: 'å¨ç§å¤«çè®º',
    description: 'æ·±å¥å­¦ä¹ å¨ç§å¤«ï¼Wyckoffï¼æ¹æ³çåä¸ªé¶æ®µï¼ç§¯ç´¯ãä¸æ¶¨ãæ´¾åãä¸è·ï¼ææ¡å¨ç§å¤«äºä»¶ä¸æµè¯çå¤æ­ã',
    category: 'advanced',
    duration: '27:20',
    articleUrl: '/models/wyckoff.html',
    cover: '/covers/ep50-wyckoff.svg',
  },
  {
    title: 'è¾ç¥ç¹æ³¢æµªçè®ºï¼ä¸ï¼',
    description: 'ç³»ç»å­¦ä¹ è¾ç¥ç¹æ³¢æµªçè®ºçåºæ¬åçï¼ææ¡5æµªæ¨å¨å3æµªè°æ´çåºæ¬ç»æï¼çè§£åæµªçç¹å¾ä¸è§åã',
    category: 'advanced',
    duration: '28:30',
    articleUrl: '/models/elliott-wave-1.html',
    cover: '/covers/ep-elliott1.svg',
  },
  // åè¾ç¥ç¹æ³¢æµªçè®ºï¼äºï¼ä½ç½®ï¼ç°æ¿æ¢ä¸ºç¼ è®ºï¼ä¿æ episode_id = 94 ç¨³å®ï¼
  {
    title: 'ç¼ è®º Â· ç¼ ä¸­è¯´ç¼ ',
    description: 'ç³»ç»å­¦ä¹ ç¼ è®ºçæ ¸å¿æ¦å¿µï¼ç¬ãçº¿æ®µãä¸­æ¢ãä¹°åç¹ãèé©°ãä»ååè¯å«å°ä¸ç±»ä¹°åç¹å®æï¼ææ¡ç¼ ä¸­è¯´ç¼ ä½ç³»ã',
    category: 'advanced',
    duration: '30:00',
    articleUrl: '/models/chanlun.html',
    cover: '/covers/ep-chanlun.svg',
  },
  {
    title: 'è°æ³¢å½¢æäº¤æ',
    description: 'å­¦ä¹ GartleyãBatãButterflyãCrabç­ç»å¸è°æ³¢å½¢æçè¯å«æ¹æ³ï¼ææ¡è°æ³¢äº¤æçå¥åºåç®æ è®¾å®ã',
    category: 'advanced',
    duration: '25:20',
    articleUrl: '/models/harmonic.html',
    cover: '/covers/ep-harmonic.svg',
  },
  // å·²ä¸çº¿ï¼ä¾éåºååæï¼å id=96ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: 'è®¢åæµåæå¥é¨',
    description: 'åæ­¥äºè§£è®¢åæµï¼Order Flowï¼çæ¦å¿µï¼å­¦ä¹ éè¿ä¹°åçå£ãæäº¤åå¸å¤æ­ç­æä»·æ ¼èµ°åçæ¹æ³ã',
    category: 'advanced',
    duration: '21:55',
    articleUrl: '/models/order-flow.html',
    cover: '/covers/ep-order-flow.svg',
  },
  // å·²ä¸çº¿ï¼å¸åºç»æçè®ºï¼å id=98ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // å·²ä¸çº¿ï¼æµå¨æ§æ¦å¿µï¼å id=99ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },

  // ===== å®æåºç¨ (51-59) =====
  // å·²ä¸çº¿ï¼å å¯è´§å¸ææ¯åæï¼å id=100ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // å·²ä¸çº¿ï¼å¤æ±å¸åºå®æï¼å id=101ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  // å·²ä¸çº¿ï¼ç¾è¡ææ¯åæï¼å id=102ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: 'äº¤æç³»ç»æ­å»º',
    description: 'ææææä½ æ­å»ºå®æ´çäº¤æç³»ç»ï¼ä»ä¿¡å·äº§çãå¥åºè§åãä»ä½ç®¡çå°åºåºç­ç¥çå¨æµç¨è®¾è®¡ã',
    category: 'strategy',
    duration: '28:15',
  },
  // å·²ä¸çº¿ï¼åæµä¸ä¼åï¼å id=104ï¼2026-04-20 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },
  {
    title: 'äº¤æå¿çå­¦',
    description: 'æ·±å¥æ¢è®¨äº¤æå¿çå¯¹å³ç­çå½±åï¼å­¦ä¹ åæææ§ãè´ªå©ªãè¿åº¦èªä¿¡ç­å¿çé·é±çå®ç¨æ¹æ³ã',
    category: 'strategy',
    duration: '19:30',
    articleUrl: '/strategies/trading-psychology.html',
    cover: '/covers/ep-trading-psychology.svg',
  },
  {
    title: 'å®çæ¡ä¾åæï¼ä¸ï¼',
    description: 'éè¿çå®å¸åºæ¡ä¾ï¼ç»¼åè¿ç¨åé¢å­¦å°çææ¯åæå·¥å·ï¼æ¼ç¤ºä»åæå°äº¤æçå®æ´å³ç­è¿ç¨ã',
    category: 'strategy',
    duration: '30:20',
  },
  {
    title: 'å®çæ¡ä¾åæï¼äºï¼',
    description: 'ç»§ç»­éè¿å®çæ¡ä¾å­¦ä¹ ï¼éç¹åæå¤±è´¥äº¤ææ¡ä¾ï¼æ»ç»å¸¸è§éè¯¯å¹¶æç¼æ¹è¿æ¹æ³ã',
    category: 'strategy',
    duration: '28:45',
  },
  // å·²ä¸çº¿ï¼ææ¯åææ»ç»ä¸å±æï¼å id=108ï¼2026-04-24 ç§»é¤ï¼
  { title: '', description: '', number: 0, category: '_hidden', duration: '0:00' },

  // ===== ç¬¬61æ ä¼åä¸å± =====
  {
    title: 'æ¯ç¹å¸ç­å¾ä¸å¨åºç°æ°´ä¸ä¸¤ä¸ªç»¿æ±åçï¼é»éç»§ç»­ç­çé¢æ¸æ°ï¼ç®åå¸åºæ¶æ¯é¢åå¼å¤ªå¤ï¼ç­è¡æåå½æ­£å¸¸',
    description: '26å¹´4æ14æ¥ Â· ç¬¬å­åä¸æ',
    number: 61,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬62æ ä¼åä¸å± =====
  {
    title: '26å¹´4æ19æ¥é»éç½é¶æ¯ç¹å¸ä¸å¨æè·¯',
    description: '26å¹´4æ19æ¥ Â· ç¬¬å­åäºæ',
    number: 62,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬63æ ä¼åä¸å± =====
  {
    title: 'æ¯ç¹å¸æè·¯æ´æ°',
    description: '26å¹´4æ22æ¥ Â· ç¬¬å­åä¸æ',
    number: 63,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬64æ ä¼åä¸å± =====
  {
    title: 'é»éæè·¯æ´æ°',
    description: '26å¹´4æ22æ¥ Â· ç¬¬å­ååæ',
    number: 64,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬65æ ä¼åä¸å± =====
  {
    title: 'é»éæ¯ç¹å¸æ´æ°',
    description: '26å¹´4æ23æ¥ Â· ç¬¬å­åäºæ Â· ä»ç»è®²äºé»éå¤§æ¹åçåºé´',
    number: 65,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬66æ ä¼åä¸å± =====
  {
    title: 'é»éå¨æ«æè·¯',
    description: '26å¹´4æ24æ¥ Â· ç¬¬å­åå­æ',
    number: 66,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬67æ ä¼åä¸å± =====
  {
    title: 'æ¯ç¹å¸é»éææ°æè·¯',
    description: '26å¹´4æ28æ¥ Â· ç¬¬å­åä¸æ',
    number: 67,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬68æ ä¼åä¸å± =====
  {
    title: '5æ8æ¥é»éæè·¯æ´æ°',
    description: '26å¹´5æ8æ¥ Â· ç¬¬å­åå«æ',
    number: 68,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬69æ ä¼åä¸å± =====
  {
    title: 'é»éç¾è¡æ¯ç¹å¸æè·¯',
    description: '26å¹´5æ13æ¥ Â· ç¬¬å­åä¹æ',
    number: 69,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬70æ ä¼åä¸å± =====
  {
    title: 'é»éæè·¯æ´æ°',
    description: '26å¹´5æ15æ¥ Â· ç¬¬ä¸åæ',
    number: 70,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬71æ ä¼åä¸å± =====
  {
    title: 'é»éæ§ä»·æ¯ä¹°å¥ç¹ä½æ´æ°',
    description: '26å¹´5æ15æ¥ Â· ç¬¬ä¸åä¸æ',
    number: 71,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬72æ ä¼åä¸å± =====
  {
    title: 'æ¯ç¹å¸æè·¯æ´æ°',
    description: '26å¹´5æ16æ¥ Â· ç¬¬ä¸åäºæ',
    number: 72,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬73æ ä¼åä¸å± =====
  {
    title: 'é»éï¼æ¯ç¹å¸ï¼ç¾è¡æè·¯ã',
    description: '26å¹´5æ18æ¥ Â· ç¬¬ä¸åä¸æ',
    number: 73,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬74æ ä¼åä¸å± =====
  {
    title: 'é»éæè·¯æ´æ°',
    description: '26å¹´5æ20æ¥ Â· ç¬¬ä¸ååæ',
    number: 74,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬75æ ä¼åä¸å± =====
  {
    title: 'åç­ç¤¾åºçä¸äºé®é¢ï¼ç®åèè',
    description: '26å¹´5æ24æ¥ Â· ç¬¬ä¸åäºæ',
    number: 75,
    category: 'indicator',
    duration: '20:00',
  },

  // ===== ç¬¬76æ ç»å½å¯ç =====
  {
    title: 'ä¸ä¸ªæåæå¦ä½ä½¿ç¨aiæå°äºæ¶¨å¹å¾é«çè¡ç¥¨',
    description: '26å¹´5æ27æ¥ Â· ç¬¬ä¸åå­æ',
    number: 76,
    category: 'indicator',
    duration: '',
    youtubeId: 'AzqaGZyI9Cg',
    accessLevel: 'logged_in',
  },

  // ===== ç¬¬77æ ä¼åä¸å± =====
  {
    title: 'è¡ææè·¯åäº«ï¼å®æ¶æ´æ°',
    description: '26å¹´5æ29æ¥ Â· ç¬¬ä¸åä¸æ',
    number: 77,
    category: 'indicator',
    duration: '20:00',
    accessLevel: 'plus_pro',
  },
]

// æå»ºå®æ´è¯¾ç¨æ°æ®
// 1. ep.number ç¡¬ç¼ç çä¼åï¼å¦ç¬¬60æï¼ï¼ä¸è®¡å¥èªå¨è®¡æ°
// 2. æ youtubeId çè§é¢è¯¾ç¨æé¡ºåºèªå¨éå¢ç¼å·
// 3. éè§é¢åå®¹ï¼ææ¯ææ /å½¢æåæ/äº¤æç­ç¥/ææ¯æ¨¡åï¼ä¸ç¼å·ï¼number = 0
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
    category: ep.category,
    contentType: ep.articleUrl ? 'article' : 'video',
    duration: ep.duration,
    youtubeId: ep.youtubeId || '',
    cover: ep.cover || '',
    gradient: gradients[i % gradients.length],
    articleUrl: ep.articleUrl || '',
    accessLevel: ep.accessLevel || 'free',
  }
})

