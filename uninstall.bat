@echo off
setlocal EnableExtensions
title Biliver Uninstaller
cd /d "%~dp0"
chcp 65001 >nul

set "POWERSHELL_EXE=powershell.exe"
where powershell.exe >nul 2>nul || set "POWERSHELL_EXE=pwsh.exe"

set "BATCH_FILE=%~f0"
set "BATCH_DIR=%~dp0"
set "PS_TMP=%TEMP%\biliver_uninstall_%RANDOM%.ps1"

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath $env:BATCH_FILE -Encoding UTF8; $m = @($lines | Select-String -Pattern '^@@BILIVER_PS@@$' | Select-Object -ExpandProperty LineNumber); if ($m.Count -ge 2) { $block = $lines[($m[0])..($m[1]-2)] -join [Environment]::NewLine; Set-Content -LiteralPath $env:PS_TMP -Value $block -Encoding UTF8 }"

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_TMP%" %*
set "EC=%errorlevel%"
del /q "%PS_TMP%" >nul 2>nul
exit /b %EC%
@@BILIVER_PS@@
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$MpvPath,
    [switch]$Silent,
    [switch]$KeepFiles,
    [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$ScriptName = 'Biliver Uninstaller'

function Write-Step    { param([string]$Text) Write-Host "`n[>] $Text" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Text) Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn    { param([string]$Text) Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Write-Err     { param([string]$Text) Write-Host "  [ERR] $Text" -ForegroundColor Red }
function Write-Info    { param([string]$Text) Write-Host "  $Text" -ForegroundColor Gray }
function Write-Success { param([string]$Text) Write-Host "`n$Text" -ForegroundColor Green }

function Unregister-Protocol {
    Write-Step "Removing biliver:// protocol registration..."
    $regRoot = 'HKCU:\Software\Classes\biliver'
    if (Test-Path $regRoot) {
        Remove-Item -Path $regRoot -Recurse -Force -ErrorAction Stop
        Write-Ok "Removed: HKCU\Software\Classes\biliver"
    } else {
        Write-Ok "biliver:// protocol was not registered (nothing to remove)"
    }
    $appRoot = 'HKCU:\Software\Biliver'
    if (Test-Path $appRoot) {
        Remove-Item -Path $appRoot -Recurse -Force -ErrorAction Stop
        Write-Ok "Removed: HKCU\Software\Biliver"
    }
}

function Find-MpvDirectory {
    $candidates = @(
        "$env:APPDATA\mpv",
        "$env:USERPROFILE\mpv",
        "$env:APPDATA\mpv.net",
        "$env:LOCALAPPDATA\mpv"
    )
    foreach ($c in $candidates) {
        $scripts = Join-Path $c 'scripts\biliver'
        $conf    = Join-Path $c 'script-opts\biliver.conf'
        if ((Test-Path $scripts) -or (Test-Path $conf)) {
            return $c
        }
    }
    return $null
}

function Remove-PluginFiles {
    param([string]$MpvDir)
    if ([string]::IsNullOrWhiteSpace($MpvDir)) {
        Write-Warn "MPV config directory not found, skipping plugin file removal"
        return
    }
    Write-Step "Removing plugin files from $MpvDir..."
    $scriptsDir = Join-Path $MpvDir 'scripts\biliver'
    $confFile   = Join-Path $MpvDir 'script-opts\biliver.conf'
    if (Test-Path $scriptsDir) {
        Remove-Item -Path $scriptsDir -Recurse -Force -ErrorAction Stop
        Write-Ok "Removed: $scriptsDir"
    }
    if (Test-Path $confFile) {
        Remove-Item -Path $confFile -Force -ErrorAction Stop
        Write-Ok "Removed: $confFile"
    }
}

function Main {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "       $ScriptName" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    Unregister-Protocol

    # 插件文件删除：默认交互确认；Silent 下仅当显式 -RemoveFiles 才删除
    $removeFiles = (-not $KeepFiles) -and ((-not $Silent) -or $RemoveFiles)
    if ($removeFiles) {
        $mpvDir = $MpvPath
        if (-not $mpvDir) { $mpvDir = Find-MpvDirectory }
        if ($mpvDir) {
            if ($Silent) {
                Remove-PluginFiles -MpvDir $mpvDir
            } else {
                Write-Info ""
                $ans = Read-Host "  Remove plugin files from $mpvDir? (Y/n)"
                if ($ans -eq '' -or $ans -match '^[yY]') {
                    Remove-PluginFiles -MpvDir $mpvDir
                } else {
                    Write-Warn "Skipping plugin file removal"
                }
            }
        } else {
            Write-Warn "MPV config directory not detected, plugin files were not removed"
        }
    } elseif (-not $KeepFiles) {
        Write-Step "Keeping installed plugin files (use -RemoveFiles to delete them)"
    }

    Write-Success "========================================"
    Write-Success "        Uninstall Complete!"
    Write-Success "========================================"
    Write-Host ""
    Write-Info "The Tampermonkey script (biliver.js) must be removed manually"
    Write-Info "in the browser's Tampermonkey dashboard."
    Write-Host ""
    if (-not $Silent) { pause }
}

try {
    Main
} catch {
    Write-Err "Unexpected error: $_"
    Write-Info "Location: line $($_.InvocationInfo.ScriptLineNumber)"
    if (-not $Silent) { pause }
    exit 1
}
@@BILIVER_PS@@
