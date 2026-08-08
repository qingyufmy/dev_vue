# 自动推理部署排空

这些命令只管理站点 Redis 中的自动推理排空租约，不包含服务器地址、凭据或宝塔命令。

```bash
node scripts/deploy/auto-inference-drain.mjs begin --ttl-seconds 900
node scripts/deploy/auto-inference-drain.mjs wait --token "$TOKEN" --timeout-seconds 900
node scripts/deploy/auto-inference-drain.mjs end --token "$TOKEN"
```

也可以让通用包装器在任意重启命令前排空，并用 `trap` 在成功、失败或中断时按 token 释放：

```bash
bash scripts/deploy/auto-inference-drain.sh -- bash ./restart-service.sh
```

`AURUM_APP_DIR`、`AURUM_DRAIN_CLI`、`DRAIN_TTL_SECONDS`、`DRAIN_WAIT_TIMEOUT_SECONDS` 和 `DRAIN_POLL_SECONDS` 可由部署环境设置。远端宝塔 `deploy.sh` 不在本仓库，后续应在实际重启命令前调用此包装器；本工具不会自行连接宝塔或执行远端操作。
