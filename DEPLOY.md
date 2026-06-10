# 宝塔面板部署教程

## 一、服务器准备

1. **宝塔面板** → 软件商店 → 安装「Node.js 版本管理器」
2. 安装 Node.js 18+（推荐 20 LTS）
3. 安装 Nginx（宝塔自带）

## 二、上传项目

```bash
# SSH 连接服务器
cd /www/wwwroot
git clone https://github.com/qingyufmy/wall-street-skill-local.git aurum-ai
cd aurum-ai
git checkout main
```

## 三、安装依赖 & 配置

```bash
cd /www/wwwroot/aurum-ai/server
npm install --production

# 创建环境变量
cat > .env << 'EOF'
JWT_SECRET=替换为你的密钥（随便写一串长字符）
EOF
```

## 四、宝塔配置 Node 项目

1. 宝塔面板 → **网站** → **Node项目** → **添加Node项目**
2. 填写：
   - **项目目录**: `/www/wwwroot/aurum-ai/server`
   - **启动文件**: `index.js`
   - **Node版本**: 选已安装的 18/20
   - **端口**: `3000`
   - **项目名称**: `aurum-ai`
3. 点击「提交」

## 五、Nginx 反向代理

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

## 六、防火墙放行

宝塔面板 → **安全** → 放行端口 `3000`（如果 Nginx 反代了可以不放行外网）

## 七、SSL 证书（推荐）

宝塔面板 → 站点设置 → SSL → Let's Encrypt → 一键申请

## 八、验证

1. 浏览器访问 `https://aurum.yourdomain.com/ai`
2. 应看到 AURUM AI 量化系统页面
3. 点击「下载桥接」获取桥接软件
4. 在本地电脑（装有 MT5 的 Windows/Mac）运行桥接，输入服务器地址和 Token

## 九、更新部署

> **首次拉取前设置凭证自动保存**（只需执行一次）：
> ```bash
> git config --global credential.helper store
> ```
> 执行后，第一次 `git pull` 会提示输入用户名和密码，之后自动保存、不再重复输入。

```bash
cd /www/wwwroot/aurum-ai
git pull origin main
cd server
npm install --production
# 在宝塔 Node 项目面板点击「重启」
```

## 注意事项

- **MT5 桥接**运行在你本地电脑（有 MT5 的那台），不是服务器上
- 服务器只运行 Web 服务和信号中转
- `data.db` 数据库会自动创建在 `server/` 目录下
- 首次访问需要注册账号（管理后台可配置用户权限）
- 如果用域名，记得配 SSL（宝塔一键申请 Let's Encrypt）
