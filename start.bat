@echo off
title ESP32 Ultrasonic Radar Launcher
echo ========================================================
echo       STARTING ESP32 ULTRASONIC RADAR SERVERS
echo ========================================================
echo.

echo [1/2] Launching Backend on Port 5000...
start "Radar Backend (:5000)" cmd /k "cd /d %~dp0backend && npm start"

timeout /t 2 /nobreak >nul

echo [2/2] Launching Frontend Dashboard on Port 5173...
start "Radar Frontend (:5173)" cmd /k "cd /d %~dp0frontend && npm run dev -- --host 0.0.0.0"

echo.
echo ========================================================
echo   Backend:  http://localhost:5000
echo   Frontend: http://localhost:5173
echo ========================================================
echo.
echo Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start http://localhost:5173

