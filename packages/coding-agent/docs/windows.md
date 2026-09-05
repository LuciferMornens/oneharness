# Windows Setup

Prime Agent supports native Windows execution from PowerShell, Command Prompt, and Windows Terminal. WSL is optional.

## Requirements

- Windows 10 or newer
- Node.js 22.8.0 or newer
- npm
- PowerShell 5.1 or newer; PowerShell 7 (`pwsh`) is preferred

Git for Windows is recommended for projects that use Bash scripts, but Prime Agent can use PowerShell when Bash is not installed.

## Install

Run the checksum-verifying installer from PowerShell:

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

Install the beta built from the latest commit on `main`:

```powershell
irm https://app.primeintellect.ai/prime-agent/install-beta.ps1 | iex
```

The installer downloads the selected release-channel pointer and `SHA256SUMS`, verifies the Prime Agent tarball, installs it globally with npm, and prepares the managed IPython runtime unless disabled.

The installed `prime-agent` command resolves through its CMD launcher, so it works even when PowerShell script execution is disabled by local policy.

Start Prime Agent in any project:

```powershell
Set-Location C:\path\to\project
prime-agent
```

## Run a Source Checkout

```powershell
Set-Location C:\path\to\prime-agent
npm ci
.\prime-agent.ps1
```

The PowerShell launcher preserves the caller's working directory, so the checkout can work on another project:

```powershell
Set-Location C:\path\to\project
& C:\path\to\prime-agent\prime-agent.ps1
```

Use `prime-agent.cmd` from Command Prompt.

## Shell Selection

Prime Agent resolves a project shell in this order:

1. `shellPath` in `~/.prime/agent/settings.json`
2. Git Bash in its standard installation locations
3. `bash.exe` on `PATH` (MSYS2, Cygwin, or Git Bash). The WSL launcher at `%SystemRoot%\System32\bash.exe` is skipped.
4. PowerShell 7 (`pwsh`)
5. Windows PowerShell (`powershell.exe`)

Set an explicit shell when a project requires one:

```json
{
  "shellPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
}
```

or:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

When PowerShell is selected, Prime Agent uses non-interactive `-Command` execution, describes the command tool with PowerShell-native examples, and maps every `%%bash` cell to the configured PowerShell interpreter.

## IPython Runtime

The managed runtime is stored under `~/.prime/agent/kernel-venvs/<schema>-<runtime-hash>` and uses the Windows virtual-environment layout automatically. To use an existing Python environment with `ipykernel`, set:

```powershell
$env:PRIME_AGENT_KERNEL_PYTHON = "C:\path\to\python.exe"
prime-agent
```

## Windows Terminal

Windows Terminal reserves `Alt+Enter` for fullscreen by default. Remap that shortcut if you want Prime Agent to receive `Alt+Enter` for follow-up messages. See [Terminal setup](terminal-setup.md).

## Diagnostics

```powershell
prime-agent --version
prime-agent status
prime-agent doctor
prime-agent doctor --fix
```

Daemon communication uses Windows named pipes derived from the agent configuration directory, preventing different Windows users or isolated configurations from competing for one machine-wide pipe. Worker and kernel processes are separated for lifecycle management, but they run with the current user's permissions and are not security sandboxes.
