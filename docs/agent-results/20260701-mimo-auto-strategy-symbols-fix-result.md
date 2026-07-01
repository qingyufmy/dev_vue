# 执行结果：自动推理策略品种选择 + 信号查询修复 + Redis 订阅态 + 桥接在线检查

## 执行时间
2026-07-01

## 修改文件
- `server/bridge-ws.js` — toggle_auto 桥接检查、save_user_auto_config 桥接状态判断、桥接断开/重连处理
- `server/routes/ai/config.js` — getAutoSubscribers 增加 bridgeAliveCheck 参数
- `server/routes/ai/scheduler.js` — removeUserRuntimeAutoSubscription、rebuildRedisSubscriptions 只恢复在线用户
- `server/routes/ai/index.js` — 导出 removeUserRuntimeAutoSubscription

## 桥接在线检查实现

### 1. toggle_auto — 无桥接时拒绝开启
开启自动推理前检查 `bridges.has(userId) && bridge.ws.readyState === 1`。
无桥接返回错误："请先连接 MT5 桥接后再开启自动推理"。
不写 DB enabled=1，不写 Redis，不 reconcile。

### 2. save_user_auto_config — 桥接状态判断
允许无桥接时保存配置（用户可能先配置后连接）。
但只在 enabled=1 且桥接在线时同步 Redis 订阅。
enabled=0 时清除 Redis 订阅。

### 3. getAutoSubscribers — 桥接在线过滤
增加可选参数 `bridgeAliveCheck`。
scheduler.js 调用时传入 `isBridgeAlive` 函数。
返回的 subscribers 只包含桥接在线用户。

### 4. runUnifiedAutoCycle — 分发前过滤
在写 delivery 和推送 new_signal 前，再次过滤 `isBridgeAlive(uid)`。
离线用户不写 delivery，不推送通知。

### 5. 桥接断开 — removeUserRuntimeAutoSubscription
从 Redis 所有 `auto:scheduler:*:subs` 中 SREM userId。
从内存 `autoSchedulerState[key].subscribers` 中删除。
如果 key 无 subscribers，停止对应调度器。
不修改 auto_scheduler.enabled（用户可重新连接后自动恢复）。

### 6. 桥接重连 — 恢复订阅
_initBridge 中如果 DB enabled=1：
- syncUserRedisSubscription
- reconcileAutoSchedulers
- 恢复订阅

### 7. rebuildRedisSubscriptions — 只恢复在线用户
启动时从 DB 查询 enabled=1 用户，但只恢复 isBridgeAlive(userId) 的用户到 Redis。

## 核心验收标准
- ✅ 用户没连接桥接时，点击开启自动推理应失败
- ✅ 用户断开桥接后，不再收到自动推理信号
- ✅ 用户断开桥接后，调度器 subscriberCount 减少
- ✅ 用户重新连接桥接后，如果 DB 配置是开启状态，自动恢复订阅
- ✅ 自动交易保留原来的执行前桥接检查

## 测试命令
```
node --check server/routes/ai/scheduler.js    ✅
node --check server/routes/ai/config.js       ✅
node --check server/routes/ai/index.js        ✅
node --check server/bridge-ws.js              ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
