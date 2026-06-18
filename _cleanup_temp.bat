@echo off
cd /d C:\Users\Administrator\Desktop\web
echo Deleting 36 temp files...
del /q _check.cjs _check_audit.mjs _check_chart.cjs _check_chart2.cjs _check_chart3.cjs _check_wc.cjs _check_ws.mjs _cleanup.cjs _cleanup2.cjs _diag_audit.mjs 2>nul
del /q _fix.cjs _fix2.cjs _fix3.cjs _fix4.cjs _fix5.cjs _fix6.cjs _fix_cache.cjs _fix_dd2.cjs _fix_drawdown.cjs _fix_final.cjs _fix_signal.cjs _fix_ver.cjs 2>nul
del /q _git.bat _impl_cache.cjs _impl_cache2.cjs _impl_chart_fn.cjs _impl_full.cjs 2>nul
del /q _peek.cjs _peek2.cjs _peek3.cjs _peek4.cjs _ver.cjs _ver2.cjs _verify.cjs 2>nul
del /q server\_check_audit.mjs server\_diag_audit.mjs 2>nul
echo Done.
dir /b _*.cjs _*.mjs _*.bat server\_*.mjs server\_*.cjs 2>nul || echo All temp files removed.
pause
