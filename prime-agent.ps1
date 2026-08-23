Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$env:PRIME_AGENT_LAUNCHER_PATH = $PSCommandPath

$skipBuildId = $args -contains "--version" -or $args -contains "-v" -or $args -contains "--help" -or $args -contains "-h"
$gitCommand = if ($skipBuildId) { $null } else { Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($null -ne $gitCommand) {
	$buildId = (& $gitCommand.Source -C $repoRoot describe --tags --always --dirty 2>$null | Out-String).Trim()
	if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($buildId)) {
		$env:PRIME_AGENT_BUILD_ID = $buildId
	}
}

$noEnvironment = $false
$useDistributionBundle = $false
$forwardArguments = @()

foreach ($argument in $args) {
	if ($argument -eq "--no-env") {
		$noEnvironment = $true
	}
	elseif ($argument -eq "--dist") {
		$useDistributionBundle = $true
	}
	else {
		$forwardArguments += $argument
	}
}

if ($noEnvironment) {
	$credentialVariables = @(
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"AUDN_API_KEY",
		"OPENAI_API_KEY",
		"PRIME_API_KEY",
		"DEEPSEEK_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_API_KEY",
		"GROQ_API_KEY",
		"CEREBRAS_API_KEY",
		"XAI_API_KEY",
		"OPENROUTER_API_KEY",
		"ORCAROUTER_API_KEY",
		"ORCA_KEY",
		"ZAI_API_KEY",
		"MISTRAL_API_KEY",
		"MINIMAX_API_KEY",
		"MINIMAX_CN_API_KEY",
		"MOONSHOT_API_KEY",
		"FIREWORKS_API_KEY",
		"AI_GATEWAY_API_KEY",
		"OPENCODE_API_KEY",
		"KIMI_API_KEY",
		"CLOUDFLARE_API_KEY",
		"CLOUDFLARE_ACCOUNT_ID",
		"CLOUDFLARE_GATEWAY_ID",
		"XIAOMI_API_KEY",
		"XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"HF_TOKEN",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME"
	)

	foreach ($variable in $credentialVariables) {
		[Environment]::SetEnvironmentVariable($variable, $null, [EnvironmentVariableTarget]::Process)
	}
	Write-Host "Running Prime Agent without API keys..."
}

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) {
	[Console]::Error.WriteLine("Node.js was not found on PATH. Install Node.js and run this launcher again.")
	exit 1
}

if ($useDistributionBundle) {
	$bundlePath = Join-Path $repoRoot "packages/coding-agent/dist/bundle/cli.js"
	if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
		[Console]::Error.WriteLine("Bundle not found at $bundlePath. Run npm run build first.")
		exit 1
	}

	& $nodeCommand.Source $bundlePath @forwardArguments
	exit $LASTEXITCODE
}

$tsxPackagePath = Join-Path $repoRoot "node_modules/tsx/package.json"
if (-not (Test-Path -LiteralPath $tsxPackagePath -PathType Leaf)) {
	[Console]::Error.WriteLine("tsx not found at $tsxPackagePath. Run npm install from the repo root first.")
	exit 1
}

$tsconfigPath = Join-Path $repoRoot "tsconfig.json"
if (-not (Test-Path -LiteralPath $tsconfigPath -PathType Leaf)) {
	[Console]::Error.WriteLine("TypeScript configuration not found at $tsconfigPath.")
	exit 1
}
$env:TSX_TSCONFIG_PATH = $tsconfigPath

$sourceRunnerPath = Join-Path $repoRoot "prime-agent-source.mjs"
if (-not (Test-Path -LiteralPath $sourceRunnerPath -PathType Leaf)) {
	[Console]::Error.WriteLine("Prime Agent source runner not found at $sourceRunnerPath.")
	exit 1
}

& $nodeCommand.Source $sourceRunnerPath @forwardArguments
exit $LASTEXITCODE
