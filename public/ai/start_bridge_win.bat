@echo off
REM AURUM AI MT5 Bridge — Windows 快速启动脚本
echo === AURUM AI Bridge (Windows) ===

REM 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 Python，请先安装 Python 3.8+
    echo 下载: https://www.python.org/downloads/
    pause
    exit /b 1
)

REM 安装依赖
echo [INFO] 安装依赖...
pip install MetaTrader5 requests --quiet 2>nul

REM 启动桥接
echo [INFO] 启动桥接...
python "%~dp0aurum_bridge_win.py" %*
pause
