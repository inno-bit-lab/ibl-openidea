# Dot-source this file to prepare the current process for local Windows builds.
& {
    $ErrorActionPreference = 'Stop'

    if (-not $IsWindows) {
        throw 'Local build scripts require Windows and Visual Studio 2022 with the C++ tools.'
    }

    $localRepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
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

    $localCmd = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
    $localEnvironment = & $localCmd /d /c "call `"$localVcvars`" >nul && set"
    if ($LASTEXITCODE -ne 0) {
        throw "Visual Studio 2022 environment initialization failed (exit $LASTEXITCODE)."
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

    if (-not (Test-Path -LiteralPath (Join-Path $localRepoRoot 'node_modules') -PathType Container)) {
        $localPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $localPnpm) {
            throw 'pnpm was not found on PATH. Install pnpm before running the local build scripts.'
        }
        Write-Host "Installing worktree dependencies in '$localRepoRoot'..."
        Push-Location -LiteralPath $localRepoRoot
        try {
            & $localPnpm.Source install --frozen-lockfile
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
