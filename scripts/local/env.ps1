# Dot-source this file to prepare the current process for local Windows builds.
& {
    $ErrorActionPreference = 'Stop'

    if (-not $IsWindows) {
        throw 'Local build scripts require Windows and Visual Studio 2022 with the C++ tools.'
    }

    $localRepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $localExistingLinker = Get-Command link.exe -CommandType Application -ErrorAction SilentlyContinue
    $localVsInitialized = (
        $env:VCINSTALLDIR -and
        $env:VCINSTALLDIR -like '*\2022\*' -and
        $env:VSCMD_ARG_TGT_ARCH -eq 'x64' -and
        $env:INCLUDE -and
        $env:LIB -and
        $localExistingLinker -and
        $localExistingLinker.Source -like '*\2022\*'
    )

    if (-not $localVsInitialized) {
        $localVswhere = if (${env:ProgramFiles(x86)}) {
            Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        }
        if (-not $localVswhere -or -not (Test-Path -LiteralPath $localVswhere -PathType Leaf)) {
            $localVswhereCommand = Get-Command vswhere -CommandType Application -ErrorAction SilentlyContinue
            $localVswhere = if ($localVswhereCommand) { $localVswhereCommand.Source } else { $null }
        }
        if (-not $localVswhere) {
            throw 'vswhere.exe was not found. Install Visual Studio 2022 with the Desktop development with C++ workload.'
        }

        $localVsPaths = @(& $localVswhere -latest -products '*' -version '[17.0,18.0)' `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
        if ($LASTEXITCODE -ne 0 -or $localVsPaths.Count -eq 0 -or -not $localVsPaths[0].Trim()) {
            throw 'Visual Studio 2022 with the C++ tools was not found. Install the Desktop development with C++ workload for VS 2022.'
        }
        $localVcvars = Join-Path $localVsPaths[0].Trim() 'VC/Auxiliary/Build/vcvars64.bat'
        if (-not (Test-Path -LiteralPath $localVcvars -PathType Leaf)) {
            throw "Visual Studio 2022's vcvars64.bat was not found at '$localVcvars'. Repair its C++ tools installation."
        }

        # VsDevCmd.bat invokes vswhere by name when reading its own version.
        $localVswhereDirectory = [System.IO.Path]::GetDirectoryName($localVswhere)
        $localPathEntries = @($env:PATH -split [System.IO.Path]::PathSeparator |
            Where-Object { $_ -and $_.TrimEnd('\', '/') -ine $localVswhereDirectory.TrimEnd('\', '/') })
        $env:PATH = (@($localVswhereDirectory) + $localPathEntries) -join [System.IO.Path]::PathSeparator
        $env:VSCMD_SKIP_SENDTELEMETRY = '1'

        $localCmd = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
        # cmd's Unicode output preserves non-ASCII entries such as user-profile paths.
        $localStart = [System.Diagnostics.ProcessStartInfo]::new()
        $localStart.FileName = $localCmd
        $localStart.UseShellExecute = $false
        $localStart.CreateNoWindow = $true
        $localStart.RedirectStandardOutput = $true
        $localStart.RedirectStandardError = $true
        $localStart.StandardOutputEncoding = [System.Text.Encoding]::Unicode
        $localStart.StandardErrorEncoding = [System.Text.Encoding]::Unicode
        # cmd.exe parses /c's remainder itself and does not accept ArgumentList's escaped quotes.
        $localStart.Arguments = "/d /u /c call `"$localVcvars`" >nul && set"
        $localEnvironmentProcess = [System.Diagnostics.Process]::new()
        $localEnvironmentProcess.StartInfo = $localStart
        try {
            $null = $localEnvironmentProcess.Start()
            $localStdout = $localEnvironmentProcess.StandardOutput.ReadToEndAsync()
            $localStderr = $localEnvironmentProcess.StandardError.ReadToEndAsync()
            if (-not $localEnvironmentProcess.WaitForExit(300000)) {
                $localEnvironmentProcess.Kill($true)
                throw 'Visual Studio 2022 environment initialization exceeded 300 seconds.'
            }
            $localEnvironment = $localStdout.GetAwaiter().GetResult() -split '\r?\n'
            $localEnvironmentErrors = $localStderr.GetAwaiter().GetResult()
            if ($localEnvironmentProcess.ExitCode -ne 0) {
                throw "Visual Studio 2022 environment initialization failed (exit $($localEnvironmentProcess.ExitCode)): $localEnvironmentErrors"
            }
            if ($localEnvironmentErrors.Trim()) {
                Write-Warning $localEnvironmentErrors.Trim()
            }
        }
        finally {
            $localEnvironmentProcess.Dispose()
        }
        foreach ($localLine in $localEnvironment) {
            $localEquals = $localLine.IndexOf('=')
            # cmd.exe also emits drive-specific variables whose names start with '='.
            if ($localEquals -gt 0) {
                [System.Environment]::SetEnvironmentVariable(
                    $localLine.Substring(0, $localEquals),
                    $localLine.Substring($localEquals + 1),
                    [System.EnvironmentVariableTarget]::Process
                )
            }
        }
    }

    if (-not $env:USERPROFILE) {
        throw 'USERPROFILE is missing; the local scripts cannot locate the Rust toolchain.'
    }
    $localCargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
    $localPathEntries = @($env:PATH -split [System.IO.Path]::PathSeparator |
        Where-Object { $_ -and $_.TrimEnd('\', '/') -ine $localCargoBin.TrimEnd('\', '/') })
    $env:PATH = (@($localCargoBin) + $localPathEntries) -join [System.IO.Path]::PathSeparator

    if (-not $env:RUSTC_WRAPPER -and (Get-Command sccache -CommandType Application -ErrorAction SilentlyContinue)) {
        $env:RUSTC_WRAPPER = 'sccache'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $localRepoRoot 'node_modules/.modules.yaml') -PathType Leaf)) {
        $localPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $localPnpm) {
            throw 'pnpm was not found on PATH. Install pnpm before running the local build scripts.'
        }
        Write-Host "Installing worktree dependencies in '$localRepoRoot'..."
        Push-Location -LiteralPath $localRepoRoot
        try {
            & $localPnpm.Source install --frozen-lockfile --config.confirmModulesPurge=false
            if ($LASTEXITCODE -ne 0) {
                throw "pnpm install --frozen-lockfile failed (exit $LASTEXITCODE)."
            }
        }
        finally {
            Pop-Location
        }
    }

    [System.IO.Directory]::CreateDirectory((Join-Path $localRepoRoot 'dist')) | Out-Null
}
