$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$localRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$localBuildExit = 1
$localBuildWatch = [Diagnostics.Stopwatch]::StartNew()

$env:CARGO_PROFILE_RELEASE_LTO = 'thin'
$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'

Push-Location -LiteralPath $localRepoRoot
try {
    # The slot wrapper also prepares VS2022, dependencies, dist and optional sccache.
    & (Join-Path $PSScriptRoot 'cargo-slot.ps1') -- pnpm tauri build --bundles nsis --config src-tauri/tauri.local.conf.json
    $localBuildExit = $LASTEXITCODE
    if ($localBuildExit -eq 0) {
        $localTauriConfig = Get-Content -LiteralPath (Join-Path $localRepoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
        $localInstallerName = "$($localTauriConfig.productName)_$($localTauriConfig.version)_x64-setup.exe"
        $localInstallerPath = Join-Path $localRepoRoot "target/release/bundle/nsis/$localInstallerName"
        if (-not (Test-Path -LiteralPath $localInstallerPath -PathType Leaf)) {
            throw "Build succeeded but the expected NSIS installer was not found: $localInstallerPath"
        }
        $localInstaller = Get-Item -LiteralPath $localInstallerPath
        Write-Host "Installer: $($localInstaller.FullName)"
        Write-Host ('Size: {0} bytes ({1:N2} MiB)' -f $localInstaller.Length, ($localInstaller.Length / 1MB))
        Write-Host ('Elapsed: {0:N1} seconds' -f $localBuildWatch.Elapsed.TotalSeconds)
    }
}
catch {
    [Console]::Error.WriteLine("[build:local] $($_.Exception.Message)")
    $localBuildExit = 1
}
finally {
    Pop-Location
}
exit $localBuildExit
