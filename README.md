# 华尔街没有技术 - 街哥课堂

wall-street-skill.com 本地克隆版本。完整的金融教育平台，包含课程管理、视频播放、答题测验、思维导图、社区论坛、审计日志等功能。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vanilla JS SPA（无框架） |
| 后端 | Node.js + Express |
| 数据库 | SQLite (better-sqlite3) |
| 认证 | JWT (jsonwebtoken) |
| 文件上传 | Multer |
| 富文本 | Quill (本地化) |
| 视频源 | B站嵌入 / YouTube IFrame API / 本地上传 |

## 功能概览

### 用户端
- 📺 **视频课程** — 分类浏览、搜索、排序（默认/最新）
- 🎬 **视频播放** — B站 / YouTube / 本地视频，自动记录进度
- 📝 **答题测验** — 每题单选，2次机会，即时反馈
- 🧠 **思维导图** — 结构化 SVG 可视化，支持缩放拖拽
- 📊 **知识点** — 信息图卡片展示
- 💬 **社区论坛** — Quill 富文本发帖、评论、点赞、置顶、加精
- 📈 **历史战绩** — 交易时间线 + MT5 实盘报告
- 🧰 **金融工具箱** — 可配置的交易工具链接
- ⚙️ **个人设置** — 头像、昵称、密码修改

### 管理后台
- 📚 **课程管理** — 新增/编辑/删除课程，支持 B站BV号、YouTube、本地视频上传
- 📦 **资源上传** — 答题 JSON、思维导图 JSON、信息图图片批量上传
- 👥 **用户管理** — 用户列表、编辑用户（邮箱/昵称/密码/套餐/到期时间）、订单查看
- 💰 **返佣系统** — 邀请规则配置、佣金记录
- 📋 **审计日志** — 登录/注册/操作记录，支持按时间/类型/关键词筛选
- ⚙️ **系统配置** — SMTP 邮箱、七牛云存储、金融工具箱、股票研究菜单

### 角色权限
| 角色 | 权限 |
|------|------|
| Free | 浏览课程列表，无法观看视频 |
| Plus | 观看视频、答题、思维导图、知识点 |
| Pro | 全部功能 + 付费帖子解锁 |
| Admin | 管理后台全部权限 |

## 快速部署

### 环境要求

- **Node.js** >= 18.x（推荐 20.x+）
- **npm** >= 9.x
- **操作系统** Windows / macOS / Linux

### 第一步：克隆仓库

```bash
git clone https://github.com/qingyufmy/wall-street-skill-local.git
cd wall-street-skill-local
```

### 第二步：安装依赖

```bash
cd server
npm install
```

### 第三步：配置环境变量（可选）

在 `server/` 目录下创建 `.env` 文件：

```env
# JWT 密钥（不设置则使用默认值）
JWT_SECRET=your-secret-key-here

# 服务端口（默认 3000）
PORT=3000
```

### 第四步：启动服务

```bash
# 在 server/ 目录下
npm start
```

服务启动后访问 http://localhost:3000

### 测试账号

| 账号 | 邮箱 | 密码 | 角色 |
|------|------|------|------|
| 管理员 | admin@wallstreetskill.com | admin123 | Admin/Pro |
| 演示用户 | demo@example.com | demo123 | Plus |

## 项目结构

```
wall-street-skill-local/
├── public/                        # 前端静态文件
│   ├── index.html                 # SPA 入口
│   ├── admin-extras.css           # 管理后台毛玻璃样式
│   ├── src/
│   │   ├── main.js                # 核心 SPA 逻辑
│   │   ├── style.css              # 主样式（含暗色模式）
│   │   ├── quill.snow.css         # Quill 编辑器样式（本地化）
│   │   ├── data/                  # 课程数据
│   │   └── lib/                   # 工具库（API封装）
│   └── trades/                    # 交易报告图片
├── server/                        # 后端
│   ├── index.js                   # Express 入口 + 心跳更新
│   ├── db.js                      # SQLite 数据库 + 审计日志辅助
│   ├── package.json               # 依赖配置
│   ├── middleware/
│   │   └── auth.js                # JWT 认证中间件
│   ├── routes/
│   │   ├── auth.js                # 登录/注册/验证码
│   │   ├── user.js                # 用户资料/通知/订单
│   │   ├── courses.js             # 课程列表/资源/答题
│   │   ├── video.js               # 视频流/进度/上传
│   │   ├── posts.js               # 社区帖子/点赞
│   │   ├── comments.js            # 评论系统
│   │   ├── trades.js              # 历史战绩
│   │   ├── payment.js             # 支付/会员
│   │   ├── config.js              # 系统配置（SMTP/七牛/工具箱/菜单）
│   │   └── admin.js               # 管理后台（用户/课程/审计日志）
│   └── uploads/                   # 用户上传文件
└── README.md
```

## API 接口

### 认证
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/login | 邮箱密码登录 |
| POST | /api/register | 注册 |
| POST | /api/send-code | 发送验证码 |

### 课程
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/courses | 课程列表 |
| GET | /api/courses/:id | 课程详情 |
| GET | /api/course-items/:id/quiz | 答题数据 |
| GET | /api/course-items/:id/resources | 资源（导图/知识点） |

### 视频
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/video-progress | 保存观看进度 |
| GET | /api/video-progress/:id | 获取观看进度 |
| GET | /api/bilibili-duration/:bvid | 获取B站视频时长 |
| POST | /api/stream | 视频上传（管理员） |
| POST | /api/video-stream | 关联视频到课程（管理员） |

### 社区
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/posts | 帖子列表 |
| POST | /api/posts | 发帖 |
| GET | /api/posts/:id | 帖子详情 |
| POST | /api/posts/:id/like | 点赞 |
| PATCH | /api/posts/:id/pin | 置顶（管理员） |
| PATCH | /api/posts/:id/feature | 加精（管理员） |
| PATCH | /api/posts/:id/lock | 锁定（管理员） |

### 用户
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/profile | 个人资料 |
| PUT | /api/profile | 更新资料 |
| GET | /api/orders | 订单列表 |
| GET | /api/notifications | 通知列表 |

### 系统配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/system-config/:category | 获取配置（管理员） |
| PUT | /api/system-config/:category | 更新配置（管理员） |
| GET | /api/system-config-public/toolbox | 金融工具箱（公开） |
| GET | /api/system-config-public/market_menu | 股票研究菜单（公开） |

### 管理后台
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin-users | 用户列表+统计 |
| PUT | /api/admin-users | 编辑用户 |
| GET | /api/admin-audit | 审计日志 |
| POST | /api/admin-course-items | 新增/编辑课程 |
| DELETE | /api/admin-course-items | 删除课程 |
| POST | /api/admin-course-resources | 上传课程资源 |
| GET | /api/trades | 历史战绩数据 |

## 数据库表

| 表名 | 说明 |
|------|------|
| users | 用户账号（含UID、last_seen_at） |
| courses | 课程数据 |
| quiz_questions | 答题题目 |
| course_resources | 课程资源（导图/知识点） |
| video_streams | 视频流配置 |
| progress | 学习进度 |
| posts | 社区帖子 |
| comments | 评论 |
| post_replies | 帖子回复 |
| post_likes | 点赞记录 |
| notifications | 通知 |
| referrals | 邀请记录 |
| orders | 订单记录 |
| trades | 交易记录 |
| system_config | 系统配置（SMTP/七牛/工具箱/菜单） |
| audit_logs | 审计日志 |
| user_notices | 用户通知 |

## 前端路由

| 路径 | 视图 | 权限 |
|------|------|------|
| / | 首页（课程列表） | 公开 |
| /course/:id | 课程详情 | 公开 |
| /video/:id | 视频播放 | Plus+ |
| /quiz/:id | 答题测验 | Plus+ |
| /mindmap/:id | 思维导图 | Plus+ |
| /knowledge/:id | 知识点 | Plus+ |
| /history | 历史战绩 | 公开 |
| /toolbox | 金融工具箱 | 公开 |
| /community | 社区论坛 | 公开 |
| /post/:id | 帖子详情 | 公开 |
| /settings | 个人设置 | 登录 |
| /admin | 管理后台 | Admin |

## 常见问题

### Q: 端口 3000 被占用？

```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <进程ID> /F

# macOS/Linux
lsof -i :3000
kill -9 <进程ID>
```

### Q: 如何重置数据库？

删除 `server/data.db` 文件后重启服务，会自动重建。

### Q: 视频上传失败？

检查 `server/uploads/` 目录是否存在且有写入权限。Multer 默认限制 500MB。

### Q: B站视频无法播放？

确认课程设置中填写了正确的 BV 号（如 `BV1xx411c7mD`）。

## License

Private - 仅供学习使用
