# OpenCursor installer for Windows.
#
#   irm https://raw.githubusercontent.com/noah-thing/open-cursor/main/install.ps1 | iex
#
# Set $env:OPENCURSOR_VERSION (e.g. v0.1.0) first to install a specific release.

# irm | iex runs in the person's own session: keep every setting change inside this block and put the TLS one back
$oldTls = [Net.ServicePointManager]::SecurityProtocol
try {
	& {
		$ErrorActionPreference = 'Stop'
		$ProgressPreference = 'SilentlyContinue'

		# Windows PowerShell 5.1 starts with TLS 1.0/1.1 only, which GitHub refuses
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

		$repo = 'noah-thing/open-cursor'
		$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
		# the latest published release (never a prerelease or draft), unless a version is asked for
		$api = if ($env:OPENCURSOR_VERSION) { "https://api.github.com/repos/$repo/releases/tags/v$($env:OPENCURSOR_VERSION.TrimStart('v'))" } else { "https://api.github.com/repos/$repo/releases/latest" }

		Write-Host 'Finding the latest OpenCursor release' -ForegroundColor White
		$release = Invoke-RestMethod $api -Headers @{ 'User-Agent' = 'opencursor-installer'; 'Accept' = 'application/vnd.github+json' }
		$asset = @($release.assets) | Where-Object { $_.name -like "*-windows-$arch-setup.exe" } | Select-Object -First 1
		if ($release.draft -or -not $asset) { throw "No OpenCursor release has a build for Windows ($arch) yet." }

		$file = Join-Path ([IO.Path]::GetTempPath()) $asset.name
		Write-Host "Downloading $($asset.name)"
		Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing

		# GitHub computes a sha256 for each release file; check it when the API gives one
		if ($asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
			$got = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
			if ($got -ne $Matches[1]) {
				Remove-Item -LiteralPath $file -Force
				throw 'The download does not match the checksum GitHub published.'
			}
		}

		Write-Host 'Installing' -ForegroundColor White
		# The per-user setup needs no administrator rights; runcode would open the app before this script ends.
		$p = Start-Process $file -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/MERGETASKS=!runcode' -Wait -PassThru
		Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
		if ($p.ExitCode -ne 0) { throw "The installer stopped with exit code $($p.ExitCode)." }

		Write-Host ''
		Write-Host "OpenCursor $($release.tag_name) is installed. Find it in the Start menu, or open a new terminal window and run: open-cursor"
	}
} finally {
	[Net.ServicePointManager]::SecurityProtocol = $oldTls
}
