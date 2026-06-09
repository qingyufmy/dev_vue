# AURUM AI Trading System v1.0.0

全自动 MT5 量化交易系统 · AI 驱动决策 · 实时信号执行

## 核心功能

- **多品种实时分析** — XAUUSD、外汇、指数，多周期自动扫描
- **AI 智能决策** — DeepSeek / GPT / Kimi / Qwen / Claude / Gemini 多模型支持
- **MT5 桥接执行** — WebSocket 长连接，信号直达 MT5 终端
- **完整风控系统** — 动态止盈止损、浮亏管理、资金保护
- **历史数据回测** — MT5 实时数据拉取与统计分析
- **Web 管理界面** — 实时监控交易状态、账户权益、持仓管理

## 项目结构

```
├── server/
│   ├── index.js              # Express 主服务（端口 3000）
│   ├── bridge-ws.js          # WebSocket MT5 桥接
│   ├── db.js                 # SQLite 数据库
│   ├── routes/
│   │   ├── ai.js             # AI/MT5 交易接口
│   │   ├── auth.js           # 认证/登录
│   │   ├── admin.js          # 管理后台
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
echo JWT_SECRET=your-secret-key-here > .env

# 3. 启动服务
node index.js
```

访问 `http://localhost:3000/ai` 进入量化系统。

## 连接 MT5

1. 在页面点击「下载桥接」获取对应平台的桥接软件（Windows / macOS）
2. 运行桥接软件，输入服务器地址和 Token
3. 桥接自动连接 MT5 终端并执行交易信号

## 环境要求

- **Node.js** >= 18
- **Python** >= 3.8（桥接端，用于 MT5 通信）
- **MetaTrader 5** 终端（桥接端需运行）

## 技术栈

- **后端**: Node.js + Express + SQLite + WebSocket
- **前端**: 原生 HTML/CSS/JS + Lucide Icons
- **桥接**: Python + MetaTrader5 + websocket-client
- **AI**: DeepSeek / GPT / Kimi / Qwen / 智谱 / 豆包 / Claude / Gemini

## 许可证

MIT License
