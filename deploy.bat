@echo off
REM ============================================================
REM  deploy.bat — Build + commit + push vers GitHub Pages
REM  Double-clic depuis "0) Trading Tools\"
REM ============================================================
cd /d "%~dp0_build"

echo [1/3] Build en cours...
call node build.mjs
if errorlevel 1 ( echo ERREUR: esbuild a echoue & pause & exit /b 1 )
python inline.py
if errorlevel 1 ( echo ERREUR: inline.py a echoue & pause & exit /b 1 )
echo Build OK.

cd /d "%~dp0"

echo [2/3] Commit...
for /f "tokens=1-3 delims=/ " %%a in ('date /t') do set TODAY=%%c-%%b-%%a
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set NOW=%%a:%%b
git add index.html "_publish/index.html" "_build/app.jsx" "Monte Carlo Ruin.html" "_build/inline.py"
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "deploy: update %TODAY% %NOW%"
    echo Commit cree.
) else (
    echo Aucun changement a committer.
)

echo [3/3] Push vers GitHub...
git push
if errorlevel 1 ( echo ERREUR: git push a echoue & pause & exit /b 1 )

echo.
echo Deploiement termine !
echo URL : https://dyfu972.github.io/monte-carlo/
echo (GitHub Pages met a jour en ~1 min)
pause
