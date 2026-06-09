#!/bin/bash
# AURUM AI MT5 Bridge — macOS 快速启动脚本
# 用法: bash start_bridge_mac.sh

set -e
echo "=== AURUM AI Bridge (macOS) ==="

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "❌ 未找到 Python3，请先安装: brew install python3"
    exit 1
fi

# 安装依赖
echo "📦 安装依赖..."
pip3 install requests --quiet 2>/dev/null || pip install requests --quiet 2>/dev/null

# 启动桥接
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "🚀 启动桥接中继..."
python3 "$SCRIPT_DIR/aurum_bridge_mac.py" "$@"
