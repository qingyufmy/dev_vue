# 华尔街没有技术 - 街哥课堂

wall-street-skill.com 本地克隆版本。完整的金融教育平台，包含课程管理、视频播放、答题测验、思维导图、社区论坛等功能。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vanilla JS SPA（无框架） |
| 后端 | Node.js + Express |
| 数据库 | SQLite (better-sqlite3) |
| 认证 | JWT (jsonwebtoken) |
| 文件上传 | Multer |
| 富文本 | Quill (CDN) |
| 视频源 | B站嵌入 / YouTube IFrame API / 本地上传 |

## 功能概览

### 用户端
- 📺 **视频课程** — 分类浏览、搜索、排序（默认/最新）
- 🎬 **视频播放** — B站 / YouTube / 本地视频，自动记录进度（3秒防抖，60%完成阈值）
- 📝 **答题测验** — 每题单选，2次机会，即时反馈
- 🧠 **思维导图** — 结构化 SVG 可视化，支持缩放拖拽
- 📊 **知识点** — 信息图卡片展示
- 💬 **社区论坛** — Quill 富文本发帖、评论、点赞、置顶、加精
- 📈 **历史战绩** — 月度盈亏图表 + 详细交易记录
- 🧰 **金融工具箱** — 策略回测工具
- ⚙️ **个人设置** — 头像、昵称、密码修改

### 管理后台
- 📚 **课程管理** — 新增/编辑/删除课程，支持 B站BV号、YouTube、本地视频上传
- 📦 **资源上传** — 答题 JSON、思维导图 JSON、信息图图片批量上传
- 👥 **用户管理** — 用户列表、计划调整、状态管理
- 💰 **返佣系统** — 邀请规则配置、佣金记录

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
├── public/                    # 前端静态文件
│   ├── index.html             # SPA 入口
│   ├── style.css              # 主样式（含暗色模式）
│   ├── admin-extras.css       # 管理后台毛玻璃样式
│   ├── src/
│   │   ├── main.js            # 核心 SPA 逻辑（路由、渲染、交互）
│   │   ├── data/              # 课程数据
│   │   └── lib/               # 工具库（API封装、课程内容缓存）
│   └── trades/                # 交易报告图片
├── server/                    # 后端
│   ├── index.js               # Express 入口
│   ├── db.js                  # SQLite 数据库初始化 + 种子数据
│   ├── package.json           # 依赖配置
│   ├── middleware/
│   │   └── auth.js            # JWT 认证中间件
│   ├── routes/
│   │   ├── auth.js            # 登录/注册/验证码
│   │   ├── user.js            # 用户资料/通知/返佣
│   │   ├── courses.js         # 课程列表/资源/答题
│   │   ├── video.js           # 视频流/进度/上传
│   │   ├── posts.js           # 社区帖子/点赞
│   │   ├── comments.js        # 评论系统
│   │   ├── trades.js          # 历史战绩
│   │   ├── payment.js         # 支付/会员
│   │   └── admin.js           # 管理后台全部接口
│   └── uploads/               # 用户上传文件（git忽略）
├── test_resources/            # 测试用课程资源
│   ├── quiz_第1期.json         # 答题测试数据
│   ├── mindmap_第1期.json      # 思维导图测试数据
│   └── infographic_第1期.png   # 信息图测试图片
└── .gitignore
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
| GET | /api/posts/:id/comments | 评论列表 |
| POST | /api/posts/:id/comments | 发评论 |

### 用户
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/profile | 个人资料 |
| PATCH | /api/profile | 更新资料 |
| GET | /api/notifications | 通知列表 |
| POST | /api/referrals/track | 记录邀请 |

### 管理后台
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin-users | 用户列表+统计 |
| GET | /api/admin/referrals | 邀请规则+统计 |
| PATCH | /api/admin/referrals/rules | 更新邀请规则 |
| POST | /api/admin-course-resources | 上传课程资源 |
| DELETE | /api/admin-course-items | 删除课程资源 |
| GET | /api/trades | 历史战绩数据 |

## 课程资源上传

### 答题 JSON 格式

```json
[
  {
    "question": "RSI指标的取值范围是多少？",
    "options": ["0-50", "0-100", "-100到100", "0-200"],
    "answer": 1,
    "explanation": "RSI的取值范围是0到100"
  }
]
```

字段说明：
- `question` — 题目（必填）
- `options` — 选项数组（必填）
- `answer` / `correctIndex` / `correct_index` — 正确答案索引，从0开始
- `explanation` — 解析（可选）
- `explanations` — 每个选项的解析数组（可选）

### 思维导图 JSON 格式

```json
{
  "mindmapTitle": "标题",
  "roots": [{
    "title": "根节点",
    "level": 1,
    "geometry": {
      "transformX": 400,
      "transformY": 50,
      "bboxWidth": 180,
      "bboxHeight": 55,
      "parentAnchorX": 580,
      "childAnchorX": 382
    },
    "children": [
      {
        "title": "子节点",
        "level": 2,
        "geometry": { "..." },
        "children": []
      }
    ]
  }]
}
```

### 信息图

支持 PNG / JPG / GIF / WebP 格式，直接上传图片文件。

### 上传方式

管理后台 → 课程资源 → 点击「编辑」→ 勾选对应资源类型 → 选择文件 → 保存

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

## 数据库

首次启动自动创建 `server/data.db`，包含以下表：

| 表名 | 说明 |
|------|------|
| users | 用户账号 |
| courses | 课程数据 |
| quiz_questions | 答题题目 |
| course_resources | 课程资源（导图/知识点） |
| video_streams | 视频流配置 |
| progress | 学习进度 |
| posts | 社区帖子 |
| comments | 评论 |
| post_likes | 点赞记录 |
| notifications | 通知 |
| referrals | 邀请记录 |
| referral_rules | 邀请规则 |
| payments | 支付记录 |
| trades | 交易记录 |

种子数据包含 10 门课程、3 个用户、交易历史等。

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
