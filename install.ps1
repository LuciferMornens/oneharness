[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[string]$VersionOrChannel,

	[switch]$NonInteractive,

	[switch]$BootstrapIPython,

	[switch]$SkipIPython
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:TemporaryDirectory = $null
$minimumNodeVersion = [Version]::new(22, 8, 0)
$officialReleaseBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev"
$unconfiguredBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE" + "_URL__"
$configuredBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE_URL__"
$unconfiguredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_" + "CHANNEL__"
$configuredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"

function Get-EnvironmentValue {
	param([Parameter(Mandatory = $true)][string]$Name)

	return [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
}

function Get-ReleaseBaseUrl {
	$override = Get-EnvironmentValue -Name "PRIME_AGENT_DOWNLOAD_BASE_URL"
	if (-not [string]::IsNullOrWhiteSpace($override)) {
		return $override.TrimEnd("/")
	}

	if ($configuredBaseUrl -eq $unconfiguredBaseUrl) {
		return $officialReleaseBaseUrl
	}

	return $configuredBaseUrl.TrimEnd("/")
}

function Get-DefaultReleaseChannel {
	if ($configuredDefaultChannel -eq $unconfiguredDefaultChannel) {
		return "stable"
	}

	return $configuredDefaultChannel
}

function Normalize-Version {
	param([Parameter(Mandatory = $true)][string]$Version)

	$normalized = $Version.Trim()
	if ($normalized.StartsWith("v", [StringComparison]::OrdinalIgnoreCase)) {
		$normalized = $normalized.Substring(1)
	}

	if ($normalized -notmatch "^[0-9A-Za-z.-]+$") {
		throw "Invalid Prime Agent version: $Version"
	}

	return $normalized
}

function New-InstallerTemporaryDirectory {
	$path = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-install-{0}" -f [Guid]::NewGuid().ToString("N"))
	[void](New-Item -ItemType Directory -Path $path)
	return $path
}

function Invoke-Download {
	param(
		[Parameter(Mandatory = $true)][string]$Uri,
		[Parameter(Mandatory = $true)][string]$Destination
	)

	Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing | Out-Null
}

function Resolve-PrimeAgentVersion {
	param(
		[string]$Selection,
		[Parameter(Mandatory = $true)][string]$ReleaseBaseUrl
	)

	$releaseChannel = Get-EnvironmentValue -Name "PRIME_AGENT_RELEASE_CHANNEL"
	if ([string]::IsNullOrWhiteSpace($releaseChannel)) {
		$releaseChannel = Get-DefaultReleaseChannel
	}

	if (-not [string]::IsNullOrWhiteSpace($Selection)) {
		if ($Selection -in @("stable", "beta")) {
			$releaseChannel = $Selection
		}
		else {
			return Normalize-Version -Version $Selection
		}
	}

	$versionOverride = Get-EnvironmentValue -Name "PRIME_AGENT_VERSION"
	if (-not [string]::IsNullOrWhiteSpace($versionOverride)) {
		return Normalize-Version -Version $versionOverride
	}

	if ($releaseChannel -notin @("stable", "beta")) {
		throw "Invalid Prime Agent release channel: $releaseChannel"
	}

	$channelUrl = "$ReleaseBaseUrl/$releaseChannel"
	$channelPath = Join-Path $script:TemporaryDirectory $releaseChannel
	Write-Host "Resolving the $releaseChannel Prime Agent release..."
	Invoke-Download -Uri $channelUrl -Destination $channelPath
	$channelVersion = (Get-Content -Raw -LiteralPath $channelPath).Trim()
	if ([string]::IsNullOrWhiteSpace($channelVersion)) {
		throw "The Prime Agent $releaseChannel release channel at $channelUrl was empty."
	}

	return Normalize-Version -Version $channelVersion
}

function Get-CommandPath {
	param([Parameter(Mandatory = $true)][string]$Name)

	$command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $command) {
		return $null
	}

	return $command.Source
}

function Get-ResolvedCommandPath {
	param([Parameter(Mandatory = $true)][string]$Name)

	$command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $command) {
		return $null
	}

	return $command.Source
}

function Assert-NodeAndNpm {
	$nodePath = Get-CommandPath -Name "node.exe"
	if ($null -eq $nodePath) {
		throw "Node.js $minimumNodeVersion or newer is required. Install the current Node.js LTS release from https://nodejs.org/en/download, reopen PowerShell, and run this installer again."
	}

	$nodeVersionText = (& $nodePath --version | Out-String).Trim()
	if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch "^v?(\d+)\.(\d+)\.(\d+)") {
		throw "Node.js at $nodePath did not report a valid version. Reinstall Node.js from https://nodejs.org/en/download, reopen PowerShell, and run this installer again."
	}

	$nodeVersion = [Version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
	if ($nodeVersion -lt $minimumNodeVersion) {
		throw "Prime Agent requires Node.js $minimumNodeVersion or newer. Found $nodeVersionText at $nodePath. Update Node.js from https://nodejs.org/en/download, reopen PowerShell, and run this installer again."
	}

	$npmPath = Get-CommandPath -Name "npm.cmd"
	if ($null -eq $npmPath) {
		throw "npm is required but npm.cmd was not found on PATH. Reinstall Node.js from https://nodejs.org/en/download with npm enabled, reopen PowerShell, and run this installer again."
	}

	$npmVersion = (& $npmPath --version | Out-String).Trim()
	if ($LASTEXITCODE -ne 0 -or $npmVersion -notmatch "^\d+\.\d+\.\d+") {
		throw "npm at $npmPath did not report a valid version. Reinstall Node.js from https://nodejs.org/en/download with npm enabled, reopen PowerShell, and run this installer again."
	}

	Write-Host "Using Node.js $nodeVersionText and npm $npmVersion."
	return $npmPath
}

function Test-InteractiveTerminal {
	if ($NonInteractive) {
		return $false
	}

	try {
		return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
	}
	catch {
		return $false
	}
}

function Confirm-DefaultYes {
	param([Parameter(Mandatory = $true)][string]$Prompt)

	$response = Read-Host "$Prompt [Y/n]"
	return $response -notmatch "^(n|no)$"
}

function Resolve-IPythonBootstrap {
	param([Parameter(Mandatory = $true)][bool]$Interactive)

	if ($BootstrapIPython -and $SkipIPython) {
		throw "Use either -BootstrapIPython or -SkipIPython, not both."
	}

	if ($BootstrapIPython) {
		return $true
	}

	if ($SkipIPython) {
		return $false
	}

	$environmentControl = Get-EnvironmentValue -Name "PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL"
	if ($environmentControl -eq "1") {
		return $true
	}

	if ($environmentControl -eq "0") {
		return $false
	}

	if (-not $Interactive) {
		Write-Host "Preparing the IPython runtime during noninteractive installation."
		return $true
	}

	return Confirm-DefaultYes -Prompt "Prepare the IPython runtime now? This installs uv, Python 3.11, ipykernel, and the Prime Agent runtime."
}

function Assert-PackageIdentity {
	param(
		[Parameter(Mandatory = $true)][string]$PackageName,
		[Parameter(Mandatory = $true)][string]$CommandName
	)

	if ($PackageName -notmatch "^[A-Za-z0-9._-]+$") {
		throw "Invalid Prime Agent release package name: $PackageName"
	}

	if ($CommandName -notmatch "^[A-Za-z0-9._-]+$") {
		throw "Invalid Prime Agent command name: $CommandName"
	}
}

function Assert-ReleaseChecksum {
	param(
		[Parameter(Mandatory = $true)][string]$ChecksumsPath,
		[Parameter(Mandatory = $true)][string]$TarballPath,
		[Parameter(Mandatory = $true)][string]$TarballName
	)

	$expectedHash = $null
	foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
		if ($line -match "^(?<hash>[0-9A-Fa-f]{64})\s+\*?(?<file>.+?)\s*$" -and $Matches.file -eq $TarballName) {
			$expectedHash = $Matches.hash
			break
		}
	}

	if ($null -eq $expectedHash) {
		throw "Checksum for $TarballName was not found in the release SHA256SUMS file."
	}

	$actualHash = (Get-FileHash -LiteralPath $TarballPath -Algorithm SHA256).Hash
	if (-not $actualHash.Equals($expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
		throw "SHA-256 verification failed for $TarballName. Expected $expectedHash but downloaded $actualHash."
	}

	Write-Host "Verified SHA-256 for $TarballName."
}

function Install-PrimeAgentPackage {
	param(
		[Parameter(Mandatory = $true)][string]$NpmPath,
		[Parameter(Mandatory = $true)][string]$TarballPath,
		[Parameter(Mandatory = $true)][bool]$BootstrapKernel
	)

	$environmentNames = @(
		"PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL",
		"PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL",
		"PRIME_AGENT_INSTALL_UV"
	)
	$previousEnvironment = @{}
	foreach ($name in $environmentNames) {
		$previousEnvironment[$name] = Get-EnvironmentValue -Name $name
	}

	try {
		$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1"
		$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = if ($BootstrapKernel) { "1" } else { "0" }
		if ($BootstrapKernel) {
			$env:PRIME_AGENT_INSTALL_UV = "1"
		}
		else {
			[Environment]::SetEnvironmentVariable("PRIME_AGENT_INSTALL_UV", $null, [EnvironmentVariableTarget]::Process)
		}

		Write-Host "Installing Prime Agent globally with npm..."
		& $NpmPath install -g --no-fund --no-audit --loglevel=error --progress=false $TarballPath
		if ($LASTEXITCODE -ne 0) {
			throw "npm install -g failed with exit code $LASTEXITCODE."
		}
	}
	finally {
		foreach ($name in $environmentNames) {
			[Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], [EnvironmentVariableTarget]::Process)
		}
	}
}

function Get-NpmGlobalPrefix {
	param([Parameter(Mandatory = $true)][string]$NpmPath)

	$prefixOutput = @(& $NpmPath prefix -g)
	if ($LASTEXITCODE -ne 0 -or $prefixOutput.Count -eq 0) {
		throw "npm prefix -g failed while locating the installed Prime Agent command."
	}

	return $prefixOutput[-1].Trim()
}

function Assert-InstalledCli {
	param(
		[Parameter(Mandatory = $true)][string]$NpmPath,
		[Parameter(Mandatory = $true)][string]$CommandName,
		[Parameter(Mandatory = $true)][string]$ExpectedVersion
	)

	$globalPrefix = Get-NpmGlobalPrefix -NpmPath $NpmPath
	$installedCommand = Join-Path $globalPrefix "$CommandName.cmd"
	if (-not (Test-Path -LiteralPath $installedCommand -PathType Leaf)) {
		throw "npm completed, but the installed CLI was not found at $installedCommand."
	}

	$versionOutput = @(& $installedCommand --version)
	if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -eq 0) {
		throw "The installed CLI at $installedCommand failed its --version check."
	}

	$installedVersion = $versionOutput[-1].Trim()
	if ($installedVersion -ne $ExpectedVersion) {
		throw "The installed CLI reported version $installedVersion; expected $ExpectedVersion."
	}

	$powerShellShim = Join-Path $globalPrefix "$CommandName.ps1"
	if (Test-Path -LiteralPath $powerShellShim -PathType Leaf) {
		[IO.File]::Delete($powerShellShim)
	}

	Write-Host "Verified $CommandName v$installedVersion at $installedCommand."
	$pathCommand = Get-ResolvedCommandPath -Name $CommandName
	if ($null -eq $pathCommand) {
		Write-Warning "$CommandName was installed, but it is not on PATH. Add $globalPrefix to your user PATH, reopen PowerShell, and run $CommandName."
	}
	elseif (-not [IO.Path]::GetFullPath($pathCommand).Equals([IO.Path]::GetFullPath($installedCommand), [StringComparison]::OrdinalIgnoreCase)) {
		throw "$CommandName was installed at $installedCommand, but PATH currently resolves it to $pathCommand. Put $globalPrefix before the older command directory, reopen PowerShell, and run this installer again."
	}
	else {
		Write-Host "Prime Agent was installed successfully. Run it with: $CommandName"
	}
}

function Invoke-Installer {
	$releaseBaseUrl = Get-ReleaseBaseUrl
	$packageName = Get-EnvironmentValue -Name "PRIME_AGENT_PACKAGE"
	if ([string]::IsNullOrWhiteSpace($packageName)) {
		$packageName = "prime-agent"
	}

	$commandName = Get-EnvironmentValue -Name "PRIME_AGENT_CMD"
	if ([string]::IsNullOrWhiteSpace($commandName)) {
		$commandName = "prime-agent"
	}

	Assert-PackageIdentity -PackageName $packageName -CommandName $commandName
	$npmPath = Assert-NodeAndNpm
	$script:TemporaryDirectory = New-InstallerTemporaryDirectory
	$version = Resolve-PrimeAgentVersion -Selection $VersionOrChannel -ReleaseBaseUrl $releaseBaseUrl
	$tarballName = "$packageName-$version.tgz"
	$releaseUrl = "$releaseBaseUrl/releases/v$version"
	$tarballUrl = "$releaseUrl/$tarballName"
	$interactive = Test-InteractiveTerminal

	if ($interactive -and -not (Confirm-DefaultYes -Prompt "Install Prime Agent v$version globally from $tarballUrl?")) {
		Write-Host "Installation cancelled."
		return
	}

	$bootstrapKernel = Resolve-IPythonBootstrap -Interactive $interactive
	$checksumsPath = Join-Path $script:TemporaryDirectory "SHA256SUMS"
	$tarballPath = Join-Path $script:TemporaryDirectory $tarballName

	Write-Host "Downloading release checksums..."
	Invoke-Download -Uri "$releaseUrl/SHA256SUMS" -Destination $checksumsPath
	Write-Host "Downloading Prime Agent v$version..."
	Invoke-Download -Uri $tarballUrl -Destination $tarballPath
	Assert-ReleaseChecksum -ChecksumsPath $checksumsPath -TarballPath $tarballPath -TarballName $tarballName
	Install-PrimeAgentPackage -NpmPath $npmPath -TarballPath $tarballPath -BootstrapKernel $bootstrapKernel
	Assert-InstalledCli -NpmPath $npmPath -CommandName $commandName -ExpectedVersion $version
}

try {
	Invoke-Installer
}
finally {
	if ($null -ne $script:TemporaryDirectory -and (Test-Path -LiteralPath $script:TemporaryDirectory)) {
		Remove-Item -LiteralPath $script:TemporaryDirectory -Recurse -Force
	}
}
