@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================================
rem  TrueDoF launcher: double-click this file.
rem  Checks what TrueDoF needs, then opens the Director (overlay window over FM).
rem    TrueDoF.bat           overlay window (F9 shows / hides it over FM)
rem    TrueDoF.bat browser   the chat in your web browser instead
rem ============================================================================
cd /d "%~dp0"
title TrueDoF
echo.
echo  TrueDoF - your Director of Football
echo  ===================================
echo.

rem ---- 1. Node.js (runs the chat app) -------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is not installed.
  echo      Install the "LTS" version from https://nodejs.org , then double-click TrueDoF.bat again.
  start "" "https://nodejs.org"
  goto :fail
)
for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo  [OK] Node.js !NODEVER!

rem ---- 2. API key in .env ----------------------------------------------------------
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  [X] No .env file yet. I made one and opened it in Notepad.
  echo      Paste your Anthropic API key after ANTHROPIC_API_KEY= , save, close Notepad,
  echo      then double-click TrueDoF.bat again. Get a key at https://console.anthropic.com
  start "" notepad ".env"
  goto :fail
)
findstr /r /c:"^ANTHROPIC_API_KEY=..*" ".env" >nul
if errorlevel 1 (
  echo  [X] Your .env file has no API key yet. Opening it in Notepad.
  echo      Paste your key after ANTHROPIC_API_KEY= , save, then double-click TrueDoF.bat again.
  start "" notepad ".env"
  goto :fail
)
echo  [OK] API key found in .env

rem ---- 3. The Anthropic library (one-time download) --------------------------------
if not exist "node_modules\@anthropic-ai\sdk" (
  echo  [..] First start: installing the Anthropic library ^(one time^)...
  call npm install --no-fund --no-audit
  if errorlevel 1 ( echo  [X] npm install failed. Check your internet connection. & goto :fail )
)
echo  [OK] Anthropic library installed

rem ---- 4. The FM plugin (only a warning: the Director still works with old data) ---
set PLUGIN=
for %%d in (C D E F G H) do (
  if exist "%%d:\XboxGames\Football Manager 27\Content\BepInEx\plugins\TrueDoF.dll" set "PLUGIN=%%d:\XboxGames\Football Manager 27\Content\BepInEx\plugins\TrueDoF.dll"
)
if exist "%ProgramFiles(x86)%\Steam\steamapps\common\Football Manager 27\BepInEx\plugins\TrueDoF.dll" set "PLUGIN=%ProgramFiles(x86)%\Steam\steamapps\common\Football Manager 27\BepInEx\plugins\TrueDoF.dll"
if defined FMDIR if exist "%FMDIR%\BepInEx\plugins\TrueDoF.dll" set "PLUGIN=%FMDIR%\BepInEx\plugins\TrueDoF.dll"
if defined PLUGIN (
  echo  [OK] FM plugin installed
) else (
  echo  [!] The FM plugin was not found in the usual places. If F8 does nothing in FM,
  echo      run Install-Plugin.bat ^(with FM closed^). See README, "Quick start".
)

if exist "%LOCALAPPDATA%\TrueDoF\dump-latest.json" (
  echo  [OK] Game data found ^(press F8 in FM to refresh it^)
) else (
  echo  [!] No game data yet: start FM, load your save and press F8.
)
echo.

rem ---- 5. Open the Director ---------------------------------------------------------
if /i "%~1"=="browser" goto :browser

set OVERLAY=overlay\bin\publish\TrueDoF.Overlay.exe
if not exist "%OVERLAY%" (
  where dotnet >nul 2>nul
  if errorlevel 1 (
    echo  [!] The overlay is not built and the .NET SDK is missing, so using your browser.
    echo      ^(For the overlay: install the .NET 8 SDK from https://dotnet.microsoft.com/download^)
    goto :browser
  )
  echo  [..] First start: building the overlay window ^(one time, about a minute^)...
  dotnet publish overlay -c Release --nologo -v q
  if errorlevel 1 ( echo  [!] Building the overlay failed, so using your browser. & goto :browser )
)
start "" "%OVERLAY%"
echo  The Director is open in its own window. Press F9 to show or hide it, also inside FM.
echo  It starts and stops the chat app by itself. You can close this window.
timeout /t 8 >nul 2>nul
exit /b 0

:browser
echo  Starting the chat app. Leave this window open while you chat; close it to stop.
start "" "http://localhost:8766"
node server\server.js
exit /b 0

:fail
echo.
pause
exit /b 1
