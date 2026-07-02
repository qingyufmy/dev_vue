# 执行结果：桥接 WSS 稳定性增强

## 执行时间
2026-07-02

## 修改文件
- `public/ai/aurum_bridge_gui.py` — HTTP 预检 + SSL 重建 + MT5 超时保护 + 心跳状态
- `server/bridge-ws.js` — upgrade 异常兜底 + 状态持久化 + heartbeat 数据存储
- `server/migrations.js` — bridge_connection_status 表
- `server/routes/ai/index.js` — 健康接口返回 recentStatus
- `DEPLOY.md` — 稳定性部署检查章节

## 客户端修改

### 1. HTTP 预检
首次连接、第 3/10 次、之后每 10 次做一次 HTTP 健康检查（timeout 5s），区分 HTTP 不通和 WSS 不通。

### 2. SSL 重建
retry_count 在 1/10/30/60 或每 30 次时重建 SSL context。

### 3. MT5 采集超时
`MT5_COLLECT_TIMEOUT_SEC = 3`，超时后跳过本轮发送，不中断 WSS。
使用 `mt5_inflight` 标记避免堆积 executor 任务。
连续超时 10 次显示"MT5响应慢"，恢复后打印恢复日志。

### 4. 心跳状态字段
发送 `mt5_collect_timeout_count`、`last_data_sent_age_sec`、`last_quote_time`。

## 服务端修改

### 1. upgrade 异常兜底
`wss.handleUpgrade()` 包裹 try-catch，异常时打印日志并销毁 socket。

### 2. bridge_connection_status 表
新增 migration 016，保存连接/断开状态、close code/reason、client_version 等。

### 3. 状态持久化
- 连接成功时 upsert `connected=1`
- 收到消息时节流更新 `last_seen_at`/`last_message_type`/`client_version`
- close 时 upsert `connected=0` + `last_close_code/reason`
- 存储 `bridge._clientHeartbeat` 供诊断接口使用

### 4. 健康接口返回 recentStatus
`/api/bridge/ws-health` 返回 `recentStatus`（最近 50 条断线记录）。

## 版本
客户端：`v2.1.2` → `v2.1.3`

## 验证命令
```
node --check server/bridge-ws.js    ✅
node --check server/routes/ai/index.js  ✅
node --check server/migrations.js   ✅
python -m py_compile public/ai/aurum_bridge_gui.py  ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
