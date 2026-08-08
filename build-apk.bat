@echo off
setlocal
echo ===================================================
echo   Thakkar Medico App - APK Builder & Multi-Exporter
echo ===================================================
node "%~dp0scripts\build-apk.js" %*
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed with exit code %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)
echo [SUCCESS] APK built and exported to multiple destinations!
pause
