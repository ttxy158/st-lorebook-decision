@echo off
rem Double-click launcher for enable-cors-proxy.ps1.
rem
rem Keep this file pure ASCII with CRLF line endings. cmd.exe re-reads batch files by byte
rem offset, and multibyte characters make it lose track of where a line starts, silently
rem turning comment lines into commands. All messages therefore live in the .ps1, where
rem UTF-8 is handled properly.
rem
rem Usage:  enable-cors-proxy.bat [SillyTavern folder]

set ARGS=
if not "%~1"=="" set ARGS=-Path "%~f1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-cors-proxy.ps1" %ARGS%

echo.
pause
