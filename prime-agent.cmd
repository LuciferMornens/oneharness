@echo off
setlocal

set "usePowerShell="
for %%I in (%*) do (
	if /i "%%~I"=="--no-env" set "usePowerShell=1"
	if /i "%%~I"=="--dist" set "usePowerShell=1"
)
if defined usePowerShell goto powershell

set "repoRoot=%~dp0"
set "PRIME_AGENT_LAUNCHER_PATH=%~f0"
set "skipBuildId="
for %%I in (%*) do (
	if /i "%%~I"=="--version" set "skipBuildId=1"
	if /i "%%~I"=="-v" set "skipBuildId=1"
	if /i "%%~I"=="--help" set "skipBuildId=1"
	if /i "%%~I"=="-h" set "skipBuildId=1"
)
if not defined skipBuildId for /f "delims=" %%I in ('git.exe -C "%repoRoot%." describe --tags --always --dirty 2^>nul') do set "PRIME_AGENT_BUILD_ID=%%I"

set "nodeCommand="
for %%I in (node.exe) do set "nodeCommand=%%~$PATH:I"
if not defined nodeCommand (
	>&2 echo Node.js was not found on PATH. Install Node.js and run this launcher again.
	exit /b 1
)

set "tsxPackagePath=%repoRoot%node_modules\tsx\package.json"
if not exist "%tsxPackagePath%" (
	>&2 echo tsx not found at %tsxPackagePath%. Run npm install from the repo root first.
	exit /b 1
)

set "tsconfigPath=%repoRoot%tsconfig.json"
if not exist "%tsconfigPath%" (
	>&2 echo TypeScript configuration not found at %tsconfigPath%.
	exit /b 1
)
set "TSX_TSCONFIG_PATH=%tsconfigPath%"

set "sourceRunnerPath=%repoRoot%prime-agent-source.mjs"
if not exist "%sourceRunnerPath%" (
	>&2 echo Prime Agent source runner not found at %sourceRunnerPath%.
	exit /b 1
)

"%nodeCommand%" "%sourceRunnerPath%" %*
set "exitCode=%ERRORLEVEL%"
endlocal & exit /b %exitCode%

:powershell
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0prime-agent.ps1" %*
set "exitCode=%ERRORLEVEL%"
endlocal & exit /b %exitCode%
