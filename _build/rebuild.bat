@echo off
REM Reconstruit la version offline + _publish\index.html apres modif de app.jsx
cd /d "%~dp0"
call npm install --no-audit --no-fund esbuild react react-dom
call node build.mjs
python inline.py
echo Termine. Fichiers : "..\Monte Carlo Ruin.html" + "..\_publish\index.html" + "..\index.html"
pause
