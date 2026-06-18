@echo off
cd /d C:\Users\Administrator\Desktop\web
git stash
git checkout main
git merge dev
git tag -f v1.9.2
git push origin main --tags -f
git checkout dev
git stash pop
echo === Done ===
