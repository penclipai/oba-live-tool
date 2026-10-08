[CmdletBinding()]
param(
    [string]$Python = "python",
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourceRoot = Join-Path $repoRoot "vendor\video-box"
$buildRoot = Join-Path $repoRoot "build"
$workRoot = Join-Path $buildRoot "video-box-work"
$runtimeRoot = Join-Path $buildRoot "video-box-runtime"
$venvRoot = Join-Path $buildRoot "video-box-venv"
$upstreamUrl = "https://github.com/penclipai/DouyinLiveRecorder.git"
$upstreamCommit = "add187f8d8c7ff7d231fcbee45cbb4f1ed247d3a"
$ffmpegUrl = "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip"
$ffmpegSha256 = "6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541"
$nodeUrl = "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip"
$nodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$downloadRoot = Join-Path $buildRoot "downloads"
$ffmpegZip = Join-Path $downloadRoot "ffmpeg-8.1.1-essentials_build.zip"
$nodeZip = Join-Path $downloadRoot "node-v24.19.0-win-x64.zip"

function Remove-BuildDirectory([string]$Path) {
    $buildPrefix = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\\') + [IO.Path]::DirectorySeparatorChar
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside build/: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to remove a reparse point: $resolved"
        }
        for ($attempt = 1; $attempt -le 12; $attempt++) {
            try {
                Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
                break
            } catch {
                if ($attempt -eq 12) { throw }
                Start-Sleep -Seconds 1
            }
        }
    }
}

function Invoke-Checked([scriptblock]$Command, [string]$Description) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

function Assert-ExpectedHash([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Missing required download: $Path" }
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    $inputStream = [IO.File]::OpenRead($Path)
    try {
        $actual = [BitConverter]::ToString($hashAlgorithm.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $inputStream.Dispose()
        $hashAlgorithm.Dispose()
    }
    if ($actual -ne $Expected) { throw "SHA256 mismatch for $Path. Expected $Expected, got $actual" }
}

if (-not (Test-Path -LiteralPath $sourceRoot)) { throw "Missing tracked video-box source: $sourceRoot" }
if ($Clean) {
    foreach ($path in @($workRoot, $runtimeRoot, $venvRoot)) {
        Remove-BuildDirectory $path
    }
}
New-Item -ItemType Directory -Force $buildRoot, $downloadRoot | Out-Null

if (-not (Test-Path -LiteralPath $ffmpegZip)) { Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip }
Assert-ExpectedHash $ffmpegZip $ffmpegSha256
if (-not (Test-Path -LiteralPath $nodeZip)) { Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip }
Assert-ExpectedHash $nodeZip $nodeSha256

Remove-BuildDirectory $workRoot
Copy-Item -LiteralPath $sourceRoot -Destination $workRoot -Recurse
Remove-BuildDirectory (Join-Path $workRoot "__pycache__")

Invoke-Checked { git clone --filter=blob:none $upstreamUrl (Join-Path $workRoot "DouyinLiveRecorder") } "git clone"
Push-Location (Join-Path $workRoot "DouyinLiveRecorder")
try {
    Invoke-Checked { git checkout --detach $upstreamCommit } "git checkout"
    $actualCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $upstreamCommit) { throw "Upstream commit verification failed" }
} finally { Pop-Location }

$pythonVersion = (& $Python --version).Trim()
if ($LASTEXITCODE -ne 0 -or $pythonVersion -ne "Python 3.14.3") { throw "Python 3.14.3 is required; found '$pythonVersion'" }
Invoke-Checked { & $Python -m venv $venvRoot } "virtualenv creation"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
Invoke-Checked { & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $workRoot "requirements.lock") } "dependency installation"
Invoke-Checked { & $venvPython (Join-Path $workRoot "patch_upstream_logger.py") (Join-Path $workRoot "DouyinLiveRecorder") } "upstream logger patch"

$ffmpegExtract = Join-Path $workRoot "ffmpeg-extract"
Remove-BuildDirectory $ffmpegExtract
Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegExtract -Force
$ffmpegBin = Get-ChildItem -Path $ffmpegExtract -Filter ffmpeg.exe -File -Recurse | Select-Object -First 1
if ($null -eq $ffmpegBin) { throw "FFmpeg archive does not contain ffmpeg.exe" }
$ffmpegRoot = Split-Path (Split-Path $ffmpegBin.FullName -Parent) -Parent
New-Item -ItemType Directory -Force (Join-Path $workRoot "vendor") | Out-Null
Copy-Item -LiteralPath $ffmpegRoot -Destination (Join-Path $workRoot "vendor\ffmpeg") -Recurse

$nodeExtract = Join-Path $workRoot "node-extract"
Remove-BuildDirectory $nodeExtract
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
$nodeExecutable = Get-ChildItem -Path $nodeExtract -Filter node.exe -File -Recurse | Select-Object -First 1
if ($null -eq $nodeExecutable) { throw "Node archive does not contain node.exe" }
Copy-Item -LiteralPath (Split-Path $nodeExecutable.FullName -Parent) -Destination (Join-Path $workRoot "vendor\node") -Recurse

Push-Location $workRoot
try { Invoke-Checked { & $venvPython -m PyInstaller --clean --noconfirm (Join-Path $workRoot "packaging\video-box.spec") } "PyInstaller" } finally { Pop-Location }
$builtRuntime = Join-Path $workRoot "dist\video-box"
foreach ($requiredFile in @(
    "video-box.exe",
    "_internal\\vendor\\ffmpeg\\bin\\ffmpeg.exe",
    "_internal\\vendor\\node\\node.exe",
    "_internal\\vendor\\node\\LICENSE",
    "_internal\\DouyinLiveRecorder\\LICENSE"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $builtRuntime $requiredFile))) {
        throw "PyInstaller output is missing required runtime file: $requiredFile"
    }
}
Remove-BuildDirectory $runtimeRoot
Copy-Item -LiteralPath $builtRuntime -Destination $runtimeRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $runtimeRoot "LICENSE.txt")
@"
video-box contains a pinned copy of DouyinLiveRecorder ($upstreamCommit).
FFmpeg is from GyanD's 8.1.1 essentials build and is distributed under its own licenses in _internal\\vendor\\ffmpeg.
Node.js is v24.19.0 from $nodeUrl (SHA-256 $nodeSha256) and is distributed under its own license in _internal\\vendor\\node.
"@ | ForEach-Object { [IO.File]::WriteAllText((Join-Path $runtimeRoot "NOTICE.txt"), $_, [Text.UTF8Encoding]::new($false)) }
@"
This backend is launched by OBA Live Tool. Runtime settings, logs, locks, and instance metadata are stored in the app data directory passed with --data-dir.
"@ | ForEach-Object { [IO.File]::WriteAllText((Join-Path $runtimeRoot "README.txt"), $_, [Text.UTF8Encoding]::new($false)) }

$verificationDataDir = Join-Path $buildRoot "video-box-verification"
Remove-BuildDirectory $verificationDataDir
New-Item -ItemType Directory -Force $verificationDataDir | Out-Null
$originalPath = $env:PATH
try {
    $env:PATH = "$env:WINDIR\System32;$env:WINDIR"
    $verificationProcess = Start-Process -FilePath (Join-Path $runtimeRoot "video-box.exe") -ArgumentList "--verify-runtime", "--data-dir", ('"{0}"' -f $verificationDataDir) -WindowStyle Hidden -PassThru -Wait
    if ($verificationProcess.ExitCode -ne 0) { throw "bundled runtime verification failed with exit code $($verificationProcess.ExitCode)" }
} finally {
    $env:PATH = $originalPath
}
$verificationReportPath = Join-Path $verificationDataDir "runtime-check.json"
if (-not (Test-Path -LiteralPath $verificationReportPath)) { throw "Bundled runtime did not write runtime-check.json" }
$verificationReport = Get-Content -Raw -LiteralPath $verificationReportPath | ConvertFrom-Json
if (-not $verificationReport.ok -or $verificationReport.nodeVersion -ne "v24.19.0") {
    throw "Bundled runtime verification failed: $(Get-Content -Raw -LiteralPath $verificationReportPath)"
}
Remove-BuildDirectory $verificationDataDir

Write-Host "Built verified relay runtime: $runtimeRoot"
