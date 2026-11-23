@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================================
rem  Builds the TrueDoF plugin and copies it into FM27 (BepInEx\plugins).
rem  Run it once, and again after each TrueDoF update. FM must be CLOSED.
rem  Needs: BepInEx 6 installed in FM (README, Phase 1) and the .NET 8 SDK.
rem ============================================================================
cd /d "%~dp0"
title TrueDoF plugin installer
echo.

tasklist /fi "imagename eq fm.exe" 2>nul | find /i "fm.exe" >nul
if not errorlevel 1 (
  echo  [X] Football Manager is running. Close FM first ^(Windows locks the plugin file while FM runs^),
  echo      then run Install-Plugin.bat again.
  goto :fail
)

where dotnet >nul 2>nul
if errorlevel 1 (
  echo  [X] The .NET 8 SDK is not installed. Get it from https://dotnet.microsoft.com/download ^(the "SDK"^).
  start "" "https://dotnet.microsoft.com/download"
  goto :fail
)

rem ---- find FM27: FMDIR if set, else Game Pass on any drive, else Steam ---------
set "FM=%FMDIR%"
if not defined FM for %%d in (C D E F G H) do (
  if not defined FM if exist "%%d:\XboxGames\Football Manager 27\Content\fm.exe" set "FM=%%d:\XboxGames\Football Manager 27\Content"
)
if not defined FM if exist "%ProgramFiles(x86)%\Steam\steamapps\common\Football Manager 27\fm.exe" set "FM=%ProgramFiles(x86)%\Steam\steamapps\common\Football Manager 27"
if not defined FM (
  echo  Could not find FM27. Paste the folder that contains fm.exe
  echo  ^(Steam: right-click FM27 - Manage - Browse local files^):
  set /p FM=  FM folder:
)
set "FM=!FM:"=!"
if not exist "!FM!\fm.exe" ( echo  [X] No fm.exe in "!FM!". & goto :fail )
if not exist "!FM!\BepInEx\core" (
  echo  [X] BepInEx is not installed in "!FM!". Follow README, Phase 1, step 1 first.
  goto :fail
)
echo  FM27 folder: !FM!
echo  Building and installing the plugin...
dotnet build plugin -c Release --nologo -v q -p:FMDir="!FM!"
if errorlevel 1 ( echo  [X] The build failed. See the messages above, or TROUBLESHOOTING.md. & goto :fail )
if not exist "!FM!\BepInEx\plugins\TrueDoF.dll" ( echo  [X] TrueDoF.dll was not copied into BepInEx\plugins. & goto :fail )
echo.
echo  [OK] Plugin installed. Start FM, load your save and press F8.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
