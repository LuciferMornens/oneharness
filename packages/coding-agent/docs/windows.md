# Windows Setup

Prime Agent supports native Windows execution from PowerShell, Command Prompt, and Windows Terminal. WSL is optional.

## Requirements

- Windows 10 or newer
- Node.js 22.8.0 or newer
- npm
- PowerShell 5.1 or newer; PowerShell 7 (`pwsh`) is preferred

Git for Windows is recommended. The command tool can fall back to PowerShell when Bash is not installed, but the Python kernel's `bash()` always needs a POSIX shell (see [Shell Selection](#shell-selection)).

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

### Kernel Shell

`bash()` inside the Python kernel runs a POSIX shell script and cannot use PowerShell or `cmd.exe`. The kernel resolves its shell separately from the command tool:

1. `kernelShellPath` in `settings.json` (must be an absolute path to an existing POSIX shell)
2. `shellPath`, when it is a POSIX shell (a PowerShell `shellPath` serves the command tool only)
3. Git Bash at `C:\Program Files\Git\bin\bash.exe` or `C:\Program Files (x86)\Git\bin\bash.exe`

The kernel never searches `PATH`, `%ProgramFiles%`, or `%LOCALAPPDATA%` for a shell: those are influenced by the environment of the project being worked on. Git installed elsewhere (winget user scope, Scoop, MSYS2) needs an explicit setting:

```json
{
  "shellPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "kernelShellPath": "C:\\Users\\you\\scoop\\apps\\git\\current\\bin\\bash.exe"
}
```

An invalid `kernelShellPath` (relative, missing, or PowerShell/cmd) is not replaced by a fallback: `bash()` raises an error that names the problem. `prime-agent doctor` prints the resolved kernel shell and its source, or the reason none was found.

Windows `bash()` limits compared to POSIX:

- Command exit draining is best-effort. There is no status channel, so a command that leaves background jobs holding the output pipe can end with truncated output.
- Cancellation cannot interrupt a cell that blocks the event loop in synchronous Python code; it cancels the active task instead. Interrupt-safe cells use `await` points.
- Job-object containment covers `bash()` children and their descendants. Subprocesses started directly from Python (for example with `subprocess.Popen`) are not contained.

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
