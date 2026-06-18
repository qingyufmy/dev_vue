@echo off
cd /d C:\Users\Administrator\Desktop\web
git add public/ai/app.js public/ai/aurum_bridge_gui.py public/ai/index.html public/ai/styles.css public/src/main.js server/bridge-ws.js server/routes/ai.js
git commit -m "v1.9.1: 三层权限硬隔离 (Free/Plus/Pro) + 观摩模式光标/开关修复 + 自动推理 plan 检查"
git push origin dev
git checkout main
git merge dev -m "Merge dev v1.9.1 into main"
git tag v1.9.1
git push origin main --tags
git checkout dev
echo DONE
