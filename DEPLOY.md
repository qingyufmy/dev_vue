# AURUM AI Trading System — 宝塔面板部署教程

> 当前版本：v2.3.4 | 最后更新：2026-07-11

## 一、服务器准备

1. **宝塔面板** → 软件商店 → 安装「Node.js 版本管理器」
2. 安装 Node.js 18+（推荐 20 LTS）
3. 安装 Nginx（宝塔自带）
4. 安装 **MySQL 5.7+**（宝塔面板 → 数据库 → MySQL）
5. 安装 **Redis**（可选，用于缓存和调度锁，无 Redis 系统正常运行但性能降低）

## 二、上传项目

```bash
# SSH 连接服务器
cd /www1/wwwroot
git clone https://gitee.com/fmyseo/wall-street-skill-local.git aurum-ai
cd aurum-ai
git checkout main
```

## 三、创建数据库

```bash
mysql -u root -p
```

```sql
CREATE DATABASE IF NOT EXISTS huaerjie_aurum CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'huaerjie_aurum'@'localhost' IDENTIFIED BY '你的密码';
GRANT ALL PRIVILEGES ON huaerjie_aurum.* TO 'huaerjie_aurum'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

## 四、安装依赖 & 配置

```bash
cd /www1/wwwroot/aurum-ai
npm install --production

# 创建环境变量
cp server/.env.example server/.env
```

编辑 `.env` 文件：

```env
# MySQL（必填）
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=huaerjie_aurum
MYSQL_PASSWORD=你的密码
MYSQL_DATABASE=huaerjie_aurum

# JWT（必填）
JWT_SECRET=替换为你的密钥（随便写一串长字符）

# 种子密码（首次部署必填，部署完成后可删除）
SEED_ADMIN_PASSWORD=替换为强密码
SEED_DEMO_PASSWORD=替换为强密码

# Server
PORT=3000

# Redis（可选 — 不设则禁用缓存）
# REDIS_HOST=127.0.0.1
# REDIS_PORT=6379
# REDIS_PASSWORD=

# CORS origins（逗号分隔）
# CORS_ORIGINS=http://localhost:3000,https://yourdomain.com

# USDT 支付（可选 — 不配置则 USDT 支付不可用）
# HD_WALLET_MNEMONIC=your twelve word mnemonic phrase here
# TRONGRID_API_KEY=your_trongrid_api_key
# ETHERSCAN_API_KEY=your_etherscan_api_key
# BSCSCAN_API_KEY=your_bscscan_api_key
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

> **说明**：首次启动会自动建表和种子数据（使用 SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD 配置的密码）
>
> **⚠️ 内存配置**：启动参数需添加 `--max-old-space-size=256`，避免堆内存耗尽导致频繁重启
>
> **⚠️ JWT_SECRET 必填**：未设置会导致服务启动失败（process.exit）
>
> **⚠️ 种子密码必填**：未设置 SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD 时首次初始化会拒绝，防止生产环境弱密码

## 五、宝塔配置 Node 项目

1. 宝塔面板 → **网站** → **Node项目** → **添加Node项目**
2. 填写：
   - **项目目录**: `/www1/wwwroot/aurum-ai`
   - **启动文件**: `server/index.js`
   - **Node版本**: 选已安装的 18/20
   - **端口**: `3000`
   - **项目名称**: `aurum-ai`
   - **Node启动参数**: `--max-old-space-size=256`
3. 点击「提交」

## 六、Nginx 反向代理

宝塔面板 → **网站** → 添加站点（如 `aurum.yourdomain.com`）→ 点击站点名 → **反向代理**：

```
目标URL: http://127.0.0.1:3000
发送域名: $host
```

**WebSocket 支持**（必须）— 编辑 Nginx 配置，在 server 块内添加：

```nginx
location /aurum-api/bridge/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
}
```

**WebSocket 排查命令**：

```bash
# 查看 Node 应用日志
pm2 logs --lines 300

# 查看 Nginx 错误日志（路径根据站点配置调整）
tail -n 300 /www/wwwlogs/站点.error.log

# 查看 Nginx 访问日志
tail -n 300 /www/wwwlogs/站点.log

# 检查 WebSocket 健康状态（需管理员权限）
curl -H "Authorization: Bearer <admin_token>" http://localhost:3000/api/bridge/ws-health
```

> 注意：普通 HTTPS/API 正常不代表 WebSocket upgrade 正常。如果桥接客户端持续重连失败，优先检查 Nginx 的 `proxy_read_timeout` 和 `proxy_buffering off` 是否正确配置。

## 七、防火墙放行

宝塔面板 → **安全** → 放行端口 `3000`（如果 Nginx 反代了可以不放行外网）

## 八、SSL 证书（推荐）

宝塔面板 → 站点设置 → SSL → Let's Encrypt → 一键申请

## 九、桥接 WSS 稳定性部署检查

### Nginx WebSocket location 必须放在通用反代前面

```nginx
location /aurum-api/bridge/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
}
```

如果还有通用反代 `location /`，必须放在 WebSocket location 后面。

### 检查 Nginx 配置

```bash
nginx -t && nginx -s reload
```

### 检查 Nginx 日志

```bash
tail -n 300 /www/wwwlogs/站点.error.log
tail -n 300 /www/wwwlogs/站点.log
```

重点看：`upstream timed out`、`connect() failed`、`prematurely closed connection`、`400/499/502/504`

### PM2 / Node 进程检查

```bash
pm2 list
pm2 logs --lines 300
pm2 describe aurum-ai
```

重点看：`restart_time` 是否持续增长、`memory` 是否接近限制、桥接断线时间是否对应 PM2 restart。

### 服务器时间同步

```bash
date && timedatectl
timedatectl set-ntp true
```

时间不同步会影响 TLS 证书判断、JWT、会员过期判断。

### WebSocket 连通性验证

部署后检查服务端日志中是否出现：

```text
[BridgeWS] upgrade path=/aurum-api/bridge/ws type=bridge tokenPresent=true ip=...
[BridgeWS] bridge connected user=...
```

如果客户端一直重连但服务端无 upgrade 日志 → 查 Nginx location、SSL、CDN。
如果有 upgrade 但无 connected → 查 JWT/会员检查。
如果 connected 后断开 → 查 close code/reason、ping timeout、PM2 重启。

### 健康接口排查

```bash
curl -H "Authorization: Bearer <admin_token>" http://localhost:3000/api/bridge/ws-health
```

返回 `bridges`（在线桥接）+ `recentStatus`（最近断线记录，含 close code/reason）。

## 十、验证

1. 浏览器访问 `https://aurum.yourdomain.com`
2. 主站页面正常加载
3. 注册/登录后点击「AI 交易」进入量化系统
4. 点击「下载桥接」获取桥接软件
5. 在本地电脑（装有 MT5 的 Windows）运行桥接

## 十一、更新部署

> **首次拉取前设置凭证自动保存**（只需执行一次）：
> ```bash
> git config --global credential.helper store
> ```
> 执行后，第一次 `git pull` 会提示输入用户名和密码，之后自动保存、不再重复输入。

```bash
cd /www1/wwwroot/aurum-ai
git pull origin main
npm install --production
# 在宝塔 Node 项目面板点击「重启」
```

## 数据库迁移（如有 schema 变更）

启动时会自动执行 `initDB()` + `runMigrations()` 迁移。新增表、字段、索引会自动创建，删除的表/字段会自动清理。无需手动执行 SQL。

## 数据库迁移版本追踪

系统使用 `schema_migrations` 表追踪已执行的迁移。迁移文件在 `server/migrations.js` 中定义。当前最新迁移：`036_unique_indexes`。

## 注意事项

- **MT5 桥接**运行在你本地电脑（有 MT5 的那台），不是服务器上
- 服务器只运行 Web 服务和信号中转
- MySQL 数据库需提前创建，表结构由程序自动管理
- 首次访问需要注册账号（管理后台可配置用户权限）
- 如果用域名，记得配 SSL（宝塔一键申请 Let's Encrypt）
- `.env` 文件包含敏感信息，已在 `.gitignore` 中排除
- Redis 可选，不配置时所有缓存调用静默返回 null，系统正常运行
- 桥接软件使用 Nuitka 打包（v2.2.0+），降低杀毒软件误报
- **USDT 支付**需配置钱包助记词和各链 API Key，详见 `.env.example`
- **种子密码**首次部署后建议从 `.env` 中移除，防止泄露
