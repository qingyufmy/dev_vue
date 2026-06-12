# AURUM AI Trading System — 宝塔面板部署教程

> 当前版本：v1.7.1 | 最后更新：2026-06-12

## 一、服务器准备

1. **宝塔面板** → 软件商店 → 安装「Node.js 版本管理器」
2. 安装 Node.js 18+（推荐 20 LTS）
3. 安装 Nginx（宝塔自带）
4. 安装 **MySQL 5.7+**（宝塔面板 → 数据库 → MySQL）

## 二、上传项目

```bash
# SSH 连接服务器
cd /www1/wwwroot
git clone https://github.com/qingyufmy/wall-street-skill-local.git aurum-ai
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
cd /www1/wwwroot/aurum-ai/server
npm install --production

# 创建环境变量
cp .env.example .env
```

编辑 `.env` 文件：

```env
# MySQL
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=huaerjie_aurum
MYSQL_PASSWORD=你的密码
MYSQL_DATABASE=huaerjie_aurum

# JWT
JWT_SECRET=替换为你的密钥（随便写一串长字符）

# Server
PORT=3000
```

> **说明**：首次启动会自动建表和种子数据（管理账号 admin@wallstreetskill.com / admin123）

## 五、宝塔配置 Node 项目

1. 宝塔面板 → **网站** → **Node项目** → **添加Node项目**
2. 填写：
   - **项目目录**: `/www1/wwwroot/aurum-ai/server`
   - **启动文件**: `index.js`
   - **Node版本**: 选已安装的 18/20
   - **端口**: `3000`
   - **项目名称**: `aurum-ai`
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
}
```

## 七、防火墙放行

宝塔面板 → **安全** → 放行端口 `3000`（如果 Nginx 反代了可以不放行外网）

## 八、SSL 证书（推荐）

宝塔面板 → 站点设置 → SSL → Let's Encrypt → 一键申请

## 九、验证

1. 浏览器访问 `https://aurum.yourdomain.com`
2. 主站页面正常加载
3. 注册/登录后点击「AI 交易」进入量化系统
4. 点击「下载桥接」获取桥接软件
5. 在本地电脑（装有 MT5 的 Windows/Mac）运行桥接

## 十、更新部署

> **首次拉取前设置凭证自动保存**（只需执行一次）：
> ```bash
> git config --global credential.helper store
> ```
> 执行后，第一次 `git pull` 会提示输入用户名和密码，之后自动保存、不再重复输入。

```bash
cd /www1/wwwroot/aurum-ai
git pull origin main
cd server
npm install --production
# 在宝塔 Node 项目面板点击「重启」
```

## 数据库迁移（如有 schema 变更）

启动时会自动执行 `initDB()` 迁移，新增表和字段会自动创建。无需手动执行 SQL。

## 注意事项

- **MT5 桥接**运行在你本地电脑（有 MT5 的那台），不是服务器上
- 服务器只运行 Web 服务和信号中转
- MySQL 数据库需提前创建，表结构由程序自动管理
- 首次访问需要注册账号（管理后台可配置用户权限）
- 如果用域名，记得配 SSL（宝塔一键申请 Let's Encrypt）
- `.env` 文件包含敏感信息，已在 `.gitignore` 中排除
