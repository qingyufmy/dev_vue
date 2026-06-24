# Project Memory

## 开发约定
- 修改软件时**不要直接打包**。先从源码启动测试，确认功能正常后，等用户明确说"打包"再执行 PyInstaller 打包和上传七牛云。
- 每次修改完成后，自动 commit + push 到 dev 分支，方便随时回档
- 需要重启服务时直接重启，不用询问
- 项目启动命令: `node server/index.js`
- 源文件: 桥接 `public/ai/aurum_bridge_gui.py`，更新器 `public/ai/aurum_updater.py`
- 打包规则: `AURUM_Bridge.spec` / `aurum_updater.spec`

- 资源文件引用规则: JS/CSS 文件在 HTML 中引用时带 `?v=YYYYMMDD` 版本号。修改任何 JS/CSS 后必须同步更新版本号为当天日期，防止浏览器缓存旧文件
  - 涉及文件: `public/ai/index.html`、`public/index.html`

## 基础设施
- MySQL: 192.168.1.254:3306, user=huaerjie, database=huaerjie
- 七牛云: bucket=aurum, domain=qiniu.acadfx.com, AK=nBN5ehGYR4JaPZPp9-hX8zkldzjTADl6IQCvUEeN, SK=AaNVNjKSq5UzTlqmMeoJ3JCVHhKWUYd00ueeIL4T
- GitHub: qingyufmy/wall-street-skill-local

## 🔴 安全红线（绝对禁止）
- **自动推理配置中的 system_prompt 是一级敏感数据**，绝不允许任何用户通过任何方式查看或泄露。
  - `global_auto_config.system_prompt` 只用于自动推理运行时构建 LLM 请求，绝不能出现在：
    - 手动推理配置界面 (`ai_config` 命令)
    - 任何 WebSocket 返回给前端的字段中
    - 任何 HTTP API 响应中
    - 日志/审计记录中
  - `getActiveConfig` 在展示层调用时必须带 `skipFallbacks: true`
  - 信号执行/手动推理等运行时调用走正常回退逻辑（拿 API Key + 风控参数），但 system_prompt 仍需脱敏
