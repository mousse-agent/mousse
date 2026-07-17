@echo off
setlocal
rem Packaged mousse-cli entry: run the Electron app in headless CLI mode.
rem Keep this file next to Mousse.exe (install dir / win-unpacked).
set "MOUSSE_CLI=1"
"%~dp0Mousse.exe" --cli %*
exit /b %ERRORLEVEL%
