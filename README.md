# AURUM AI Trading System v1.6.1

全自动 MT5 量化交易系统 · AI 驱动决策 · WebSocket 纯转发架构 · 实时信号执行

## 核心功能

- **多品种实时分析** — XAUUSD、外汇、指数，多周期自动扫描
- **AI 智能决策** — DeepSeek / GPT / Kimi / Qwen / Claude / Gemini 多模型支持
- **MT5 桥接执行** — WebSocket 长连接，信号直达 MT5 终端
- **完整风控系统** — 动态止盈止损、浮亏管理、资金保护
- **历史数据回测** — MT5 实时数据拉取与统计分析
- **Web 管理界面** — 实时监控交易状态、账户权益、持仓管理
- **模型共享** — 管理员开启共享后，普通用户无需配置 API Key 即可使用 AI 推理

## 项目结构

```
├── server/
│   ├── index.js              # Express 主服务（端口 3000）
│   ├── bridge-ws.js          # WebSocket MT5 桥接
│   ├── db.js                 # MySQL 数据库（mysql2）
│   ├── .env.example          # 环境变量模板
│   ├── routes/
│   │   ├── ai.js             # AI/MT5 交易接口
│   │   ├── auth.js           # 认证/登录
│   │   ├── admin.js          # 管理后台
│   │   ├── config.js         # 系统配置
│   │   ├── courses.js        # 课程管理
│   │   ├── posts.js          # 帖子系统
│   │   ├── video.js          # 视频管理
│   │   └── ...
│   └── middleware/auth.js    # JWT 认证中间件
├── public/
│   ├── ai/
│   │   ├── index.html        # 量化系统主页面
│   │   ├── app.js            # 前端交易逻辑
│   │   ├── styles.css        # 样式表
│   │   ├── AURUM_Bridge.exe          # Windows MT5 桥接
│   │   ├── AURUM_Bridge_Mac.command  # macOS MT5 桥接
│   │   └── aurum_bridge_gui.py       # 桥接源码
│   ├── index.html            # 主站首页
│   └── src/
│       ├── main.js           # 主站前端逻辑
│       └── style.css         # 主站样式
└── README.md
```

## 快速开始

```bash
# 1. 安装依赖
cd server
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 MySQL 连接信息和 JWT 密钥

# 3. 创建数据库
mysql -u root -e "CREATE DATABASE IF NOT EXISTS huaerjie CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 4. 启动服务（自动建表和种子数据）
node index.js
```

访问 `http://localhost:3000` 进入主站，点击「AI 交易」进入量化系统。

## 环境变量

在 `server/.env` 中配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MYSQL_HOST` | MySQL 地址 | `192.168.1.254` |
| `MYSQL_PORT` | MySQL 端口 | `3306` |
| `MYSQL_USER` | MySQL 用户名 | `huaerjie` |
| `MYSQL_PASSWORD` | MySQL 密码 | - |
| `MYSQL_DATABASE` | 数据库名 | `huaerjie` |
| `JWT_SECRET` | JWT 签名密钥 | - |
| `PORT` | 服务端口 | `3000` |

## 连接 MT5

1. 登录主站后点击「AI 交易」进入量化系统
2. 点击「下载桥接」获取对应平台的桥接软件（Windows / macOS）
3. 运行桥接软件，自动连接 MT5 终端
4. 桥接连接后默认关闭交易发送，需手动开启

## 环境要求

- **Node.js** >= 18
- **MySQL** >= 5.7
- **Python** >= 3.8（桥接端，用于 MT5 通信）
- **MetaTrader 5** 终端（桥接端需运行）

## 技术栈

- **后端**: Node.js + Express + MySQL (mysql2) + WebSocket
- **前端**: 原生 HTML/CSS/JS + Lucide Icons
- **桥接**: Python + MetaTrader5 + numpy + websocket-client
- **AI**: DeepSeek / GPT / Kimi / Qwen / 智谱 / 豆包 / Claude / Gemini

## 课程资源上传说明

发布课程时可通过「课程资源」面板批量上传答题、思维导图、信息图等资源。

### 目录结构

支持两种上传方式：

**1. 文件夹批量上传（推荐）**

将资源文件放入一个文件夹，整体拖入「NotebookLM 文件夹」上传区：
```
课程资源文件夹/
├── quiz_01.json          # 答题文件
├── mindmap_structure.json # 思维导图结构
├── mindmap.png           # 思维导图图片
├── infographic.png       # 信息图
└── ...                   # 更多文件
```

**2. 单文件补充上传**

散文件通过「补充单个文件」上传区补充（支持 `.json` 和图片）。

### 文件命名规则

系统根据文件名关键词自动识别类型：

| 类型 | 文件名关键词 | 格式 |
|------|-------------|------|
| 答题 | `quiz`、`题目`、`答题`、`测验` | `.json` |
| 思维导图（结构） | `mindmap`、`导图`、`思维`、`structure` | `.json` |
| 思维导图（图片） | `mindmap`、`导图`、`思维` | `.png` `.jpg` `.svg` `.webp` |
| 信息图 | `infographic`、`信息图`、`图解` | `.png` `.jpg` `.svg` `.webp` |

### 文件内容格式

#### 答题 JSON (`quiz.json`)

```json
[
  {
    "question": "什么是支撑位？",
    "options": ["价格下跌后反弹的位置", "价格上涨后回落的位置", "价格长期横盘的区间", "成交量最大的价位"],
    "answer": 0,
    "explanation": "支撑位是价格下跌到某一水平后，买方力量增强导致价格反弹的位置。",
    "explanations": ["正确！", "这是阻力位的定义。", "横盘区间不是支撑位。", "成交量与支撑位无直接关系。"],
    "hint": "注意区分支撑位和阻力位"
  },
  {
    "question": "MA 均线金叉代表什么？",
    "options": ["短期均线上穿长期均线", "短期均线下穿长期均线", "价格突破均线", "均线走平"],
    "answer": 0,
    "explanation": "金叉是短期均线从下方上穿长期均线，通常视为看涨信号。"
  }
]
```

**字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `question` | string | ✅ | 题目文本 |
| `options` | string[] | ✅ | 选项数组 |
| `answer` | number | ✅ | 正确答案索引（从 0 开始） |
| `explanation` | string | | 正确答案的解析 |
| `explanations` | string[] | | 每个选项的解析（与 options 一一对应） |
| `hint` | string | | 答题提示 |

#### 思维导图结构 JSON (`mindmap_structure.json`)

```json
{
  "title": "技术分析基础",
  "children": [
    {
      "title": "K 线形态",
      "children": [
        { "title": "锤子线", "children": [] },
        { "title": "吞没形态", "children": [] }
      ]
    },
    {
      "title": "均线系统",
      "children": [
        { "title": "MA5 / MA10 / MA20" },
        { "title": "金叉与死叉" }
      ]
    }
  ]
}
```

**结构说明：**
- 根节点 `title` 作为导图标题
- `children` 为子节点数组，支持无限嵌套
- 无 `children` 的节点为叶子节点

#### 信息图

直接上传图片文件（PNG/JPG/SVG/WebP），文件名包含「信息图」「infographic」或「图解」即可自动识别。

### 上传面板说明

上传时需勾选要导入的资源类型：
- ✅ **答题** — 导入 JSON 题目文件
- ✅ **导图** — 导入思维导图 JSON 结构或图片
- ✅ **信息图** — 导入信息图图片

未勾选的类型文件会被跳过。上传完成后会显示导入统计和跳过文件列表。

## 更新日志

### v1.6.1 (2026-06-11)
- **删除 AURUM 登录页** — 未登录访问 /ai/ 自动跳转主站，点击 AI 交易弹出登录框
- **主站退出联动** — 主站退出登录后 AURUM 同步清除 Token
- **交易开关默认关闭** — 桥接连接后交易发送默认关闭，需手动开启
- **自动推理信号切换** — 自动推理产生新信号时自动切换到最新信号
- **MT5 报价时间修复** — 报价时间和审计记录统一显示 MT5 经纪商时间（UTC+3）
- **模型共享修复** — 管理员开启共享后普通用户可正常推理和保存配置
- **MySQL 配置优化** — 改用 .env 文件管理数据库连接信息

### v1.6.0 (2026-06-11)
- **MySQL 迁移** — 从 SQLite 迁移到 MySQL，支持更高并发
- **系统提示词共享** — 管理员统一设置，所有用户自动使用
- **模型共享开关** — 管理员可共享 AI 模型配置给普通用户
- **桥接 EXE 升级** — 打包 numpy 依赖，修复 MT5 C 扩展加载问题

### v1.5.0 (2026-06-10)
- **WebSocket 纯转发架构** — 桥接→服务器→浏览器全链路 WS，1秒实时推送
- **信号有效期 WS 驱动刷新** — 服务端统一真相源，废弃客户端计时器
- **自动推理信号实时推送** — 新信号即时到达前端

### v1.0.0 (2026-06-09)
- 初始发布：AI 融合交易系统，MT5 桥接，多模型支持

## 许可证

MIT License
