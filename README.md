# AURUM AI Trading System v2.3.4

全自动 MT5 量化交易系统 · AI 驱动决策 · WebSocket 纯转发架构 · 实时信号执行

## 核心功能

- **多品种实时分析** — XAUUSD、外汇、指数，多周期自动扫描
- **AI 智能决策** — DeepSeek / GPT / Kimi / Qwen / Claude / Gemini 多模型支持
- **MT5 桥接执行** — WebSocket 长连接，信号直达 MT5 终端
- **完整风控系统** — 动态止盈止损、浮亏管理、资金保护
- **挂单系统** — AI 自动挂单（限价/止损），生命周期管理 + 对账
- **历史数据回测** — MT5 实时数据拉取与统计分析
- **缠论结构计算** — 自动识别笔、段、中枢，支撑 AI 决策
- **Web 管理界面** — 实时监控交易状态、账户权益、持仓管理
- **模型共享** — 管理员开启共享后，普通用户无需配置 API Key 即可使用 AI 推理
- **自动推理** — 定时自动分析市场，可配置自动执行
- **市场状态检测** — 自动检测开市/休市状态
- **手机号登录** — 支持邮箱 + 手机号双模式注册/登录，阿里云短信验证码
- **USDT 支付** — 纯链上监控（零平台费），TRC-20/ERC-20/BEP-20/SPL 四链支持
- **AI 自学习** — 基于历史信号表现自动优化推理策略（可关闭）
- **需求反馈** — 用户反馈系统 + 管理员自动邮件通知

## 项目结构

```
├── server/
│   ├── index.js              # Express 主服务（端口 3000）
│   ├── config.js             # 环境变量 + 常量（DEFAULT_API_BASE_URL 等）
│   ├── bridge-ws.js          # WebSocket MT5 桥接
│   ├── db.js                 # MySQL 数据库（mysql2）+ 自动建表
│   ├── migrations.js         # 数据库迁移（schema_migrations 表追踪）
│   ├── redis.js              # Redis 缓存（可选，优雅降级）
│   ├── middleware/auth.js    # JWT 认证中间件
│   ├── routes/
│   │   ├── ai/               # AI 交易模块（拆分 7 文件）
│   │   │   ├── index.js      # 入口 + Router
│   │   │   ├── utils.js      # 纯函数工具
│   │   │   ├── market-data.js # 行情计算 + 桥接
│   │   │   ├── llm.js        # AI 推理 + 信号标准化
│   │   │   ├── config.js     # 配置管理 + 风控
│   │   │   ├── strategy.js   # 策略上下文 + 执行
│   │   │   └── scheduler.js  # 自动调度 + 智能平仓
│   │   ├── auth.js           # 认证/登录（邮箱+手机号）
│   │   ├── admin.js          # 管理后台
│   │   ├── config.js         # 系统配置
│   │   ├── payment.js        # 支付/会员（USDT 链上支付）
│   │   ├── user.js           # 用户资料
│   │   ├── posts.js          # 帖子/社区
│   │   ├── comments.js       # 评论
│   │   ├── feedback.js       # 需求反馈
│   │   ├── video.js          # 视频资源
│   │   └── sentiment.js      # 情绪晴雨表
│   ├── crypto/               # USDT 支付系统
│   │   ├── wallet.js         # HD 钱包（BIP44）
│   │   ├── monitor.js        # 链上事件监控
│   │   ├── fixed-address.js  # 固定地址模式
│   │   ├── qr.js             # 支付 QR 生成
│   │   ├── sweep.js          # 链上资金归集
│   │   ├── constants.js      # 合约地址常量
│   │   └── chains/           # 四链适配器（TRON/ETH/BSC/SOL）
│   ├── .env.example          # 环境变量模板
│   └── tests/                # 单元测试（vitest）
├── public/
│   ├── ai/
│   │   ├── index.html        # AI 交易实验室主页面
│   │   ├── guide.html        # 使用手册（独立页面）
│   │   ├── styles.css        # 交易界面样式
│   │   └── app.js            # 前端交易逻辑（4900+ 行）
│   ├── index.html            # 主站首页
│   └── src/
│       ├── main.js           # 主站前端逻辑
│       └── style.css         # 主站样式
├── tests/                    # 单元测试（468 个）
├── AGENTS.md                 # 开发规范
├── CODE_REVIEW.md            # 代码审查清单
├── DEPLOY.md                 # 部署教程
├── VERSION                   # 版本号（单一源）
└── README.md
```

## 快速开始

```bash
# 1. 克隆项目
git clone https://gitee.com/fmyseo/wall-street-skill-local.git
cd wall-street-skill-local

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp server/.env.example server/.env
# 编辑 server/.env 填入 MySQL 连接信息和 JWT 密钥（JWT_SECRET 必填）
# 首次部署需设置 SEED_ADMIN_PASSWORD 和 SEED_DEMO_PASSWORD

# 4. 启动服务（自动建表 + 种子数据）
npm run dev
```

访问 `http://localhost:3000` 进入主站，点击「AI 交易」进入量化系统。

## 环境变量

在 `server/.env` 中配置：

| 变量 | 说明 | 默认值 | 必填 |
|------|------|--------|------|
| `MYSQL_HOST` | MySQL 地址 | `127.0.0.1` | ✅ |
| `MYSQL_PORT` | MySQL 端口 | `3306` | ✅ |
| `MYSQL_USER` | MySQL 用户名 | - | ✅ |
| `MYSQL_PASSWORD` | MySQL 密码 | - | ✅ |
| `MYSQL_DATABASE` | 数据库名 | - | ✅ |
| `JWT_SECRET` | JWT 签名密钥 | - | ✅ |
| `SEED_ADMIN_PASSWORD` | 管理员初始密码 | - | ✅（首次部署） |
| `SEED_DEMO_PASSWORD` | 演示用户密码 | - | ✅（首次部署） |
| `PORT` | 服务端口 | `3000` | |
| `REDIS_HOST` | Redis 地址（不设则禁用缓存） | - | |
| `REDIS_PORT` | Redis 端口 | `6379` | |
| `REDIS_PASSWORD` | Redis 密码 | - | |
| `UPLOAD_DIR` | 上传目录 | `./uploads` | |
| `CORS_ORIGINS` | CORS 允许源（逗号分隔） | localhost + cnfxtrade.com | |
| `DEBUG_CHAN` | 缠论调试日志 | `0` | |
| `DEBUG_LLM_PAYLOAD` | LLM 请求调试日志 | `0` | |
| `HD_WALLET_MNEMONIC` | USDT 钱包助记词（12词） | - | USDT 支付 |
| `TRONGRID_API_KEY` | TronGrid API Key | - | USDT 支付 |
| `ETHERSCAN_API_KEY` | Etherscan API Key | - | USDT 支付 |
| `BSCSCAN_API_KEY` | BSCScan API Key | - | USDT 支付 |
| `SOLANA_RPC_URL` | Solana RPC 节点 | `https://api.mainnet-beta.solana.com` | USDT 支付 |

## 连接 MT5

1. 登录主站后点击「AI 交易」进入量化系统
2. 点击「下载桥接」获取 Windows 桥接软件
3. 运行桥接软件，自动连接 MT5 终端
4. 桥接连接后默认关闭交易发送，需手动开启

## 环境要求

- **Node.js** >= 18
- **MySQL** >= 5.7
- **Python** >= 3.8（桥接端，用于 MT5 通信）
- **MetaTrader 5** 终端（桥接端需运行）
- **Redis**（可选，用于缓存和调度锁）

## 技术栈

- **后端**: Node.js (ESM) + Express + MySQL (mysql2/promise) + WebSocket (ws)
- **缓存**: Redis（可选，优雅降级）
- **限流**: express-rate-limit
- **前端**: 原生 HTML/CSS/JS + TradingView Lightweight Charts + Chart.js
- **桥接**: Python + MetaTrader5 + numpy + websocket-client（Nuitka 打包）
- **AI**: DeepSeek / GPT / Kimi / Qwen / 智谱 / 豆包 / Claude / Gemini
- **支付**: USDT 链上支付（TRC-20/ERC-20/BEP-20/SPL）
- **短信**: 阿里云 SMS
- **邮件**: nodemailer

## 测试

```bash
npm test            # 运行全部 468 个测试
npm run test:watch  # 监听模式
```

覆盖范围：AI 推理、信号标准化、配置管理、缠论计算、策略执行、调度器、认证、支付、USDT 链适配器。

## 安全审计

经过 10 轮全面审查，累计修复 60 项问题：

| 严重度 | 数量 | 覆盖范围 |
|--------|------|---------|
| CRITICAL | 10 | XSS、路径穿越、支付竞态、NaN 风控绕过 |
| HIGH | 14 | SL/TP 缺失保护、BSC 支付检测、事务安全 |
| MEDIUM | 31 | 数据一致性、性能优化、UI 修复 |
| LOW | 5 | 代码质量 |

## 更新日志

### v2.3.4 (2026-07-11)
- **全面安全审计** — 10 轮审查修复 60 项（XSS/路径穿越/竞态/风控）
- **AI 核心加固** — NaN confidence 防护、SL/TP 缺失保护、空数据守卫
- **支付安全** — 取消-确认竞态修复、推荐积分退还、activateMembership 事务
- **BSC 支付** — 补全链扫描缺失链，BEP-20 USDT 支付可正常检测
- **AI 自学习架构** — 信号效果追踪 + 性能聚合 + 推理注入 + 自适应校准（默认关闭）
- **自动推理修复** — 调度器锁状态同步、Redis 订阅重建、品种选择持久化
- **USDT 支付系统** — 四链 HD 钱包、链上事件监控、QR 码生成
- **前端修复** — 盈亏百分比公式修正、挂单空状态样式统一
- **测试覆盖** — 从 166 增至 468 个（vitest）

### v2.2.0 (2026-07-04)
- **Nuitka 打包** — 桥接从 PyInstaller 切换到 Nuitka，降低杀毒误报
- **挂单生命周期** — AI 自动挂单 + MT5 对账 + 过期取消 + 同向覆盖
- **手机号登录** — 邮箱/手机号双模式注册、登录、密码重置、绑定
- **CAPTCHA 验证码** — SVG 防机器人验证，弹窗失败不关闭
- **全面安全审计** — 三轮审计修复 30+ 项（路径穿越、XSS、错误泄露、认证）
- **空 catch 块治理** — 39 个空 catch 块中 13 个关键处添加日志
- **测试覆盖** — 从 75 增至 166 个（auth/payment/ai 全覆盖）
- **Chart.js 延迟加载** — 按需加载，减少首屏体积

### v2.1.1 (2026-06-27)
- 三层权限硬隔离、观摩模式、自动推理信号推送

### v2.1.0 (2026-06-25)
- 统一调度重构、提示词策略系统、Redis 调度锁

### v2.0.x (2026-06)
- MySQL 迁移、WebSocket 纯转发、管理看板、Redis 缓存、桥接稳定性

### v1.9.x (2026-06)
- 智能平仓、市场状态检测、K线图、历史回测、权限体系

## 许可证

MIT License
