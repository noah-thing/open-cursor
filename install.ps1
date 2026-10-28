# OpenCursor installer for Windows.
#
#   irm https://raw.githubusercontent.com/noah-thing/open-cursor/main/install.ps1 | iex
#
# Set $env:OPENCURSOR_VERSION (e.g. v0.1.0) first to install a specific release.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'noah-thing/open-cursor'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$api = if ($env:OPENCURSOR_VERSION) { "https://api.github.com/repos/$repo/releases/tags/$($env:OPENCURSOR_VERSION)" } else { "https://api.github.com/repos/$repo/releases/latest" }

Write-Host 'Finding the latest OpenCursor release' -ForegroundColor White
$release = Invoke-RestMethod $api -Headers @{ 'User-Agent' = 'opencursor-installer'; 'Accept' = 'application/vnd.github+json' }
$asset = $release.assets | Where-Object { $_.name -like "*-windows-$arch-setup.exe" } | Select-Object -First 1
if (-not $asset) { throw "Release $($release.tag_name) has no build for Windows ($arch)." }

$file = Join-Path ([IO.Path]::GetTempPath()) $asset.name
Write-Host "Downloading $($asset.name)"
Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing

Write-Host 'Installing' -ForegroundColor White
# The per-user setup needs no administrator rights; runcode would open the app before this script ends.
Start-Process $file -ArgumentList '/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode' -Wait
Remove-Item $file -Force

Write-Host ''
Write-Host "OpenCursor $($release.tag_name) is installed. Find it in the Start menu, or run: open-cursor"
