@echo off
title ESP32 Radar Simulator Launcher
echo ========================================================
echo   STARTING ESP32 RADAR IN DEMO / SIMULATION MODE
echo ========================================================
echo.

echo [1/2] Launching Backend with Simulated Targets...
start "Radar Backend (Simulation)" cmd /k "cd /d %~dp0backend && npm run mock"

timeout /t 2 /nobreak >nul

echo [2/2] Launching Frontend Dashboard...
start "Radar Frontend (:5173)" cmd /k "cd /d %~dp0frontend && npm run dev -- --host 0.0.0.0"

echo.
echo Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start http://localhost:5173

