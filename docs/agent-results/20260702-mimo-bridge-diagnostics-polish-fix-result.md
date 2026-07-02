# 执行结果：桥接 WSS 诊断准确性修复

## 执行时间
2026-07-02

## 修改文件
- `server/bridge-ws.js` — last_pong_at 独立节流
- `public/ai/aurum_bridge_gui.py` — HTTP 正常但 WSS 失败提示

## 修复内容

### last_pong_at 独立节流
- 新增 `_lastPongDbWrite` 节流标记
- hb/pong 消息单独写 `last_pong_at`，不被 data 消息抢占
- 60 秒节流窗口，与普通状态写入独立

### HTTP 正常但 WSS 失败提示
- 使用局部变量 `last_health_ok`/`last_health_check_retry`/`last_wss_hint_retry`
- 健康检查成功时设置标记
- WSS 失败且同轮健康检查成功时打印提示
- 只在做健康检查的同一轮失败时提示一次

## 验证命令
```
node --check server/bridge-ws.js    ✅
python -m py_compile public/ai/aurum_bridge_gui.py  ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
