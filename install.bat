@echo off
setlocal EnableExtensions
title Biliver Installer
cd /d "%~dp0"
chcp 65001 >nul

set "POWERSHELL_EXE=powershell.exe"
where powershell.exe >nul 2>nul || set "POWERSHELL_EXE=pwsh.exe"

set "BATCH_FILE=%~f0"
set "BATCH_DIR=%~dp0"
set "PS_TMP=%TEMP%\biliver_install_%RANDOM%.ps1"

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
    [switch]$NoBackup,
    [switch]$UseMirror,
    [switch]$NoProtocol
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$ScriptName    = 'Biliver Installer'
$ScriptVersion = '3.0.0'
$RequiredFiles = @('main.lua', 'biliver.py', 'biliver.js', 'biliver.conf', 'biliver_handler.py')

function Write-Step    { param([string]$Text) Write-Host "`n[>] $Text" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Text) Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn    { param([string]$Text) Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Write-Err     { param([string]$Text) Write-Host "  [ERR] $Text" -ForegroundColor Red }
function Write-Info    { param([string]$Text) Write-Host "  $Text" -ForegroundColor Gray }
function Write-Success { param([string]$Text) Write-Host "`n$Text" -ForegroundColor Green }

function Get-ScriptDirectory { if ($env:BATCH_DIR) { return $env:BATCH_DIR.TrimEnd('\') } return Split-Path -Parent $PSCommandPath }

function Initialize-Environment {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "       $ScriptName v$ScriptVersion" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    } catch {}
    $policy = Get-ExecutionPolicy -Scope CurrentUser
    if ($policy -match 'Restricted|Undefined') {
        Write-Warn "Execution policy restriction detected ($policy), attempting to bypass..."
        try {
            Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop
            Write-Ok "Temporarily bypassed execution policy (current session only)"
        } catch {
            Write-Err "Unable to bypass execution policy."
            Write-Info "Run manually: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned"
            if (-not $Silent) { pause }
            exit 1
        }
    }
}

function Test-SourceFiles {
    param([string]$SrcDir)
    Write-Step "Checking source files..."
    $missing = @()
    foreach ($file in $RequiredFiles) {
        $fullPath = Join-Path $SrcDir $file
        if (-not (Test-Path -Path $fullPath -PathType Leaf)) {
            $missing += $file
        }
    }
    if ($missing.Count -gt 0) {
        Write-Err "Missing the following files:"
        $missing | ForEach-Object { Write-Info "  - $_" }
        Write-Info ""
        Write-Info "Ensure this script is in the same directory as:"
        $RequiredFiles | ForEach-Object { Write-Info "  - $_" }
        if (-not $Silent) { pause }
        exit 1
    }
    Write-Ok "All required files are ready"
    return $true
}

function Find-MpvDirectory {
    Write-Step "Detecting MPV config directory..."
    $candidates = @(
        [PSCustomObject]@{ Path = "$env:APPDATA\mpv";         Name = '%APPDATA%\mpv' },
        [PSCustomObject]@{ Path = "$env:USERPROFILE\mpv";     Name = '%USERPROFILE%\mpv' },
        [PSCustomObject]@{ Path = "$env:APPDATA\mpv.net";     Name = '%APPDATA%\mpv.net' },
        [PSCustomObject]@{ Path = "$env:LOCALAPPDATA\mpv";    Name = '%LOCALAPPDATA%\mpv' }
    )
    foreach ($c in $candidates) {
        $confPath = Join-Path $c.Path 'mpv.conf'
        $exePath  = Join-Path $c.Path 'mpv.exe'
        if ((Test-Path $confPath) -or (Test-Path $exePath)) {
            Write-Ok "Auto-detected: $($c.Path)"
            return $c.Path
        }
    }
    Write-Warn "MPV config directory not auto-detected."
    Write-Info ""
    Write-Info "Common locations:"
    $candidates | ForEach-Object { Write-Info "  $($_.Path)" }
    if ($Silent) {
        $defaultPath = "$env:APPDATA\mpv"
        Write-Info "Silent mode, using default: $defaultPath"
        return $defaultPath
    }
    Write-Info ""
    $mpvDir = Read-Host "  Enter MPV config path (press Enter for $env:APPDATA\mpv)"
    if ([string]::IsNullOrWhiteSpace($mpvDir)) {
        $mpvDir = "$env:APPDATA\mpv"
    }
    return $mpvDir
}

function Confirm-MpvDirectory {
    param([string]$MpvDir)
    if ($Silent) { return $MpvDir }
    Write-Info ""
    Write-Info "  Target: $MpvDir"
    $confirm = Read-Host "  Confirm? (Y/n)"
    if ($confirm -match '^[nN]') {
        $newPath = Read-Host "  Enter the correct path"
        if (-not [string]::IsNullOrWhiteSpace($newPath)) {
            $MpvDir = $newPath
        }
    }
    return $MpvDir
}

function Validate-Path {
    param([string]$Path)
    $invalidChars = [System.IO.Path]::GetInvalidPathChars() -join ''
    if ($Path -match "[$([regex]::Escape($invalidChars))]") {
        Write-Err "Path contains invalid characters"
        return $false
    }
    try {
        if (-not (Test-Path $Path)) {
            New-Item -Path $Path -ItemType Directory -Force -ErrorAction Stop | Out-Null
            Write-Ok "Created directory: $Path"
        }
        $testFile = Join-Path $Path '.write_test'
        New-Item -Path $testFile -ItemType File -Force -ErrorAction Stop | Out-Null
        Remove-Item -Path $testFile -Force -ErrorAction Stop
        return $true
    } catch {
        Write-Err "Cannot access or write to directory: $Path"
        Write-Info "Error: $_"
        return $false
    }
}

function Request-Backup {
    param([string]$FilePath)
    if ($NoBackup) { return $false }
    if ($Silent)   { return $true }
    $fileName = Split-Path $FilePath -Leaf
    Write-Warn "Already exists: $fileName"
    $choice = Read-Host "  Backup existing file? (Y/n)"
    return ($choice -eq '' -or $choice -match '^[yY]')
}

function Backup-File {
    param([string]$FilePath)
    try {
        $backupPath = "$FilePath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
        Copy-Item -Path $FilePath -Destination $backupPath -Force -ErrorAction Stop
        Write-Ok "Backed up: $(Split-Path $backupPath -Leaf)"
    } catch {
        Write-Warn "Backup failed: $_"
    }
}

function Copy-PluginFiles {
    param([string]$SrcDir, [string]$MpvDir)
    Write-Step "Copying plugin files..."
    $scriptsDir    = Join-Path $MpvDir 'scripts\biliver'
    $scriptOptsDir = Join-Path $MpvDir 'script-opts'
    foreach ($dir in @($scriptsDir, $scriptOptsDir)) {
        if (-not (Test-Path $dir)) {
            New-Item -Path $dir -ItemType Directory -Force -ErrorAction Stop | Out-Null
            Write-Ok "Created: $dir"
        }
    }
    $fileMap = @(
        @{ Source = 'main.lua';            DestDir = $scriptsDir },
        @{ Source = 'biliver.py';          DestDir = $scriptsDir },
        @{ Source = 'biliver_handler.py';  DestDir = $scriptsDir },
        @{ Source = 'biliver.conf';        DestDir = $scriptOptsDir }
    )
    $successCount = 0
    $failCount    = 0
    foreach ($mapping in $fileMap) {
        $srcPath  = Join-Path $SrcDir $mapping.Source
        $destPath = Join-Path $mapping.DestDir $mapping.Source
        if (Test-Path $destPath) {
            if (Request-Backup -FilePath $destPath) {
                Backup-File -FilePath $destPath
            }
        }
        try {
            Copy-Item -Path $srcPath -Destination $destPath -Force -ErrorAction Stop
            if (Test-Path $destPath) {
                Write-Ok "$($mapping.Source) -> $(Split-Path $mapping.DestDir -Leaf)\"
                $successCount++
            } else {
                Write-Err "$($mapping.Source) missing after copy"
                $failCount++
            }
        } catch {
            Write-Err "$($mapping.Source) copy failed: $_"
            $failCount++
        }
    }
    Write-Info ""
    Write-Info "  Success: $successCount, Failed: $failCount"
    if ($failCount -gt 0) {
        Write-Err "Some files failed to copy, check permissions and retry"
        if (-not $Silent) { pause }
        exit 1
    }
    return $true
}

function Find-Python {
    Write-Step "Checking Python environment..."
    $pythonCmds = @('python', 'python3', 'py -3', 'py -3.11', 'py -3.10', 'py -3.9', 'py -3.8', 'py -3.7')
    foreach ($cmd in $pythonCmds) {
        try {
            $output = & $cmd --version 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "$output"
                return $cmd
            }
        } catch {
            continue
        }
    }
    Write-Warn "Python not detected!"
    Write-Info "  Install Python 3.7+ from https://www.python.org/downloads/"
    Write-Info "  Check 'Add Python to PATH' during installation"
    return $null
}

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments)
    $parts = $Command -split '\s+', 2
    $exe = $parts[0]
    $prefixArgs = @()
    if ($parts.Count -gt 1) { $prefixArgs += $parts[1] }
    $allArgs = $prefixArgs + $Arguments
    $proc = Start-Process -FilePath $exe -ArgumentList $allArgs -Wait -PassThru -NoNewWindow -ErrorAction Stop
    return $proc.ExitCode
}

function Test-InternetConnection {
    try {
        return (Test-Connection -ComputerName 'pypi.org' -Count 1 -Quiet -ErrorAction Stop)
    } catch {
        return $false
    }
}

function Install-PythonDependencies {
    param([string]$PythonCmd)
    Write-Info ""
    Write-Info "  Checking dependencies (aiohttp, brotli)..."
    try {
        & $PythonCmd -c 'import aiohttp, brotli' 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Dependencies already installed"
            return $true
        }
    } catch {}
    Write-Warn "Missing dependencies, installing..."

    $useMirror = $UseMirror
    if (-not $Silent -and -not $useMirror -and -not (Test-InternetConnection)) {
        Write-Info "  Cannot reach pypi.org directly."
        $ans = Read-Host "  Use Tsinghua mirror instead? (Y/n)"
        if ($ans -eq '' -or $ans -match '^[yY]') { $useMirror = $true }
    }
    if (-not $useMirror -and -not (Test-InternetConnection)) {
        Write-Err "Cannot connect to PyPI, check network"
        Write-Info "  Or run manually: pip install aiohttp brotli"
        return $false
    }

    $pipArgs = @('-m', 'pip', 'install', 'aiohttp', 'brotli', '--disable-pip-version-check', '--quiet')
    if ($useMirror) {
        $pipArgs += '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'
        Write-Info "  Using Tsinghua mirror..."
    }
    try {
        $code = Invoke-Native -Command $PythonCmd -Arguments $pipArgs
        if ($code -eq 0) {
            Write-Ok "Dependencies installed successfully"
            return $true
        }
    } catch {
        Write-Err "Dependency installation failed: $_"
    }
    Write-Err "Dependency installation failed"
    Write-Info "  Run manually: pip install aiohttp brotli"
    return $false
}

function Check-PythonEnvironment {
    $pythonCmd = Find-Python
    if (-not $pythonCmd) { return $false }
    return (Install-PythonDependencies -PythonCmd $pythonCmd)
}

function Check-Mpv {
    Write-Step "Checking MPV..."
    try {
        $output = & mpv --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            $versionLine = $output | Select-String 'mpv' | Select-Object -First 1
            if ($versionLine) {
                Write-Ok "$($versionLine.Line.Trim())"
            } else {
                Write-Ok "MPV is installed"
            }
            return $true
        }
    } catch {}
    Write-Warn "MPV is not in system PATH"
    Write-Info "  Add MPV folder to environment variables, or use full path to launch"
    return $false
}

function Register-BiliverProtocol {
    param([string]$HandlerPath)
    Write-Step "Registering biliver:// protocol..."

    $pythonCmd = Find-Python
    if (-not $pythonCmd) {
        Write-Warn "Python not found, cannot register biliver:// protocol"
        Write-Info "  Run install.bat again after installing Python"
        return $false
    }

    $parts = $pythonCmd -split '\s+'
    $base  = $parts[0]
    $prefix = @($parts | Select-Object -Skip 1)
    $exePath = (Get-Command $base -ErrorAction SilentlyContinue).Source
    if (-not $exePath) {
        Write-Warn "Cannot resolve python executable: $pythonCmd"
        return $false
    }

    # 优先使用 pythonw/pyw，避免处理器启动时黑框一闪
    $dir = Split-Path $exePath -Parent
    $leaf = Split-Path $exePath -Leaf
    $windowless = $null
    if ($leaf -like 'python*') {
        $candidate = Join-Path $dir ($leaf -replace '^python', 'pythonw')
        if (Test-Path $candidate) { $windowless = $candidate }
    } elseif ($leaf -eq 'py.exe') {
        $candidate = Join-Path $dir 'pyw.exe'
        if (Test-Path $candidate) { $windowless = $candidate }
    }
    if (-not $windowless) { $windowless = $exePath }

    $regRoot = 'HKCU:\Software\Classes\biliver'
    New-Item -Path $regRoot -Force | Out-Null
    New-Item -Path "$regRoot\DefaultIcon" -Force | Out-Null
    New-Item -Path "$regRoot\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $regRoot -Name '(default)' -Value 'URL:Biliver Protocol' -Force
    Set-ItemProperty -Path $regRoot -Name 'URL Protocol' -Value '' -Force
    Set-ItemProperty -Path $regRoot -Name 'NoOpenWith' -Value '' -Force
    Set-ItemProperty -Path "$regRoot\DefaultIcon" -Name '(default)' -Value "$handlerPath,0" -Force

    $cmd = '"' + $windowless + '" ' + ($prefix -join ' ') + ' "' + $handlerPath + '" "%1"'
    Set-ItemProperty -Path "$regRoot\shell\open\command" -Name '(default)' -Value $cmd -Force
    Write-Ok "Protocol registered: biliver://"
    Write-Info "  $cmd"

    # 记录 mpv 路径，处理器优先使用，避免仅依赖 PATH
    New-Item -Path 'HKCU:\Software\Biliver' -Force | Out-Null
    $mpvCmd = Get-Command mpv.exe -ErrorAction SilentlyContinue
    if (-not $mpvCmd) { $mpvCmd = Get-Command mpv -ErrorAction SilentlyContinue }
    $mpvExe = $null
    if ($mpvCmd) {
        $src = $mpvCmd.Source
        if ([IO.Path]::GetExtension($src) -eq '.com') {
            $sibling = Join-Path (Split-Path $src) 'mpv.exe'
            $mpvExe = if (Test-Path $sibling) { $sibling } else { $src }
        } else {
            $mpvExe = $src
        }
    }
    if (-not $mpvExe) {
        $default = Join-Path $env:APPDATA 'mpv\mpv.exe'
        if (Test-Path $default) { $mpvExe = $default }
    }
    if ($mpvExe) {
        Set-ItemProperty -Path 'HKCU:\Software\Biliver' -Name 'MpvPath' -Value $mpvExe -Force
        Write-Ok "mpv path saved: $mpvExe"
    } else {
        Write-Warn "mpv not found in PATH; handler will search default locations"
    }
    return $true
}

function Show-Completion {
    param([string]$MpvDir, [string]$SrcDir)
    Write-Success "========================================"
    Write-Success "         Installation Complete!"
    Write-Success "========================================"
    Write-Host ""
    Write-Host "Installed:" -ForegroundColor White
    Write-Info "  $(Join-Path $MpvDir 'scripts\biliver\main.lua')"
    Write-Info "  $(Join-Path $MpvDir 'scripts\biliver\biliver.py')"
    Write-Info "  $(Join-Path $MpvDir 'scripts\biliver\biliver_handler.py')"
    Write-Info "  $(Join-Path $MpvDir 'script-opts\biliver.conf')"
    Write-Host ""
    Write-Host "Manual steps required:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. Install Tampermonkey extension" -ForegroundColor White
    Write-Info "     https://www.tampermonkey.net/"
    Write-Host ""
    Write-Host "  2. Create a new Tampermonkey script and paste:" -ForegroundColor White
    Write-Info "     $(Join-Path $SrcDir 'biliver.js')"
    Write-Host ""
    Write-Host "  3. (Recommended) Add to mpv.conf:" -ForegroundColor White
    Write-Info "     watch-later-options-remove=sub-pos"
    Write-Host ""
    Write-Host "Usage: On a Bilibili page, click the play icon," -ForegroundColor White
    Write-Info "       MPV opens directly (one-click, requires biliver:// protocol)."
    Write-Info "       The copy button still works as a manual fallback."
    Write-Host ""
    Write-Host "Shortcut: Ctrl+D to toggle danmaku" -ForegroundColor White
    Write-Success "========================================"
}

function Main {
    Initialize-Environment
    $srcDir = Get-ScriptDirectory
    Test-SourceFiles -SrcDir $srcDir | Out-Null
    if ($MpvPath) {
        $mpvDir = $MpvPath
    } else {
        $mpvDir = Find-MpvDirectory
    }
    $mpvDir = Confirm-MpvDirectory -MpvDir $mpvDir
    $resolvedPath = Resolve-Path $mpvDir -ErrorAction SilentlyContinue
    if ($resolvedPath) {
        $mpvDir = $resolvedPath.Path
    }
    if (-not (Validate-Path -Path $mpvDir)) {
        if (-not $Silent) { pause }
        exit 1
    }
    Copy-PluginFiles -SrcDir $srcDir -MpvDir $mpvDir | Out-Null
    $scriptsDir = Join-Path $mpvDir 'scripts\biliver'
    $handlerPath = Join-Path $scriptsDir 'biliver_handler.py'

    $registerProtocol = $true
    if ($NoProtocol) {
        $registerProtocol = $false
    } elseif (-not $Silent) {
        $ans = Read-Host "  Register biliver:// protocol for one-click MPV? (Y/n)"
        if ($ans -match '^[nN]') { $registerProtocol = $false }
    }
    if ($registerProtocol) {
        Register-BiliverProtocol -HandlerPath $handlerPath | Out-Null
    } else {
        Write-Warn "Skipping biliver:// protocol registration (no one-click launch)"
    }

    Check-PythonEnvironment | Out-Null
    Check-Mpv | Out-Null
    Show-Completion -MpvDir $mpvDir -SrcDir $srcDir
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