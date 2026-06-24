# Project Memory

## 开发约定
- 修改软件时**不要直接打包**。先从源码启动测试，确认功能正常后，等用户明确说"打包"再执行 PyInstaller 打包和上传七牛云。
- 每次修改完成后，自动 commit + push 到 dev 分支，方便随时回档
- 需要重启服务时直接重启，不用询问
- 项目启动命令: `node server/index.js`
- 源文件: 桥接 `public/ai/aurum_bridge_gui.py`，更新器 `public/ai/aurum_updater.py`
- 打包规则: `AURUM_Bridge.spec` / `aurum_updater.spec`

## 基础设施
- MySQL: 192.168.1.254:3306, user=huaerjie, database=huaerjie
- 七牛云: bucket=aurum, domain=qiniu.acadfx.com
- GitHub: qingyufmy/wall-street-skill-local
