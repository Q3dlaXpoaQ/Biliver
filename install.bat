@echo off
title Biliver Installer
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "install.ps1" %*
if errorlevel 1 pause
