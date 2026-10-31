param(
    [switch] $FullDebug,
    [string] $SeedFrom,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$devExitCode = 1

function Warn-OccupiedDevPorts([int] $Port) {
    $addresses = @([Net.IPAddress]::Loopback)
    if ([Net.Sockets.Socket]::OSSupportsIPv6) { $addresses += [Net.IPAddress]::IPv6Loopback }
    if ($env:TAURI_DEV_HOST) { $addresses += [Net.Dns]::GetHostAddresses($env:TAURI_DEV_HOST) }
    $addresses = @($addresses | Sort-Object -Property IPAddressToString -Unique)
    foreach ($candidate in @($Port, ($Port + 1))) {
        foreach ($address in $addresses) {
            $listener = [Net.Sockets.TcpListener]::new($address, $candidate)
            try { $listener.Start() }
            catch [Net.Sockets.SocketException] {
                if ($_.Exception.SocketErrorCode -notin 'AddressAlreadyInUse', 'AccessDenied') { throw }
                Write-Warning "Development port $candidate is unavailable on $address. Vite uses strictPort=false and may choose another port; the launcher's resolved devUrl will then differ from the prebuild TAURI_CONFIG and openidea will rebuild."
            }
            finally { $listener.Stop() }
        }
    }
}

Push-Location -LiteralPath $repoRoot
try {
    # Use the same identity and preferred port as the upstream launcher and Rust runtime.
    $selectionJson = & node --input-type=module -e "import { worktreeId, worktreeRoot, preferredVitePort } from './scripts/dev-session.ts'; const id = worktreeId(worktreeRoot); console.log(JSON.stringify({ id, port: preferredVitePort(id) }))"
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the development identity from scripts/dev-session.ts.' }
    $selection = $selectionJson | ConvertFrom-Json
    $identifier = [string]$selection.id
    $devPort = [int]$selection.port
    if (-not $SeedFrom) {
        $installedIdentifier = 'it.innobitlab.iblopenidea'
        $profileBases = @($env:APPDATA, $env:LOCALAPPDATA)
        $installedProfile = $profileBases | Where-Object {
            $_ -and (Test-Path -LiteralPath (Join-Path $_ $installedIdentifier) -PathType Container)
        }
        $SeedFrom = if ($installedProfile) { $installedIdentifier } else { 'ai.l0ng.openidea' }
    }
    $debugInfo = if ($FullDebug) { 'full' } else { 'line-tables-only' }
    Write-Host "Profile: $identifier"
    Write-Host "Port: $devPort (check also $($devPort + 1))"
    Write-Host "IBLOPENIDEA_SEED_FROM=$SeedFrom"
    Write-Host "CARGO_PROFILE_DEV_DEBUG=$debugInfo"
    if ($WhatIf) { return }

    . (Join-Path $PSScriptRoot 'env.ps1')
    $env:CARGO_PROFILE_DEV_DEBUG = $debugInfo
    Warn-OccupiedDevPorts $devPort
    $devConfig = Get-Content -LiteralPath 'src-tauri/tauri.dev.conf.json' -Raw | ConvertFrom-Json -AsHashtable
    $devConfig['build'] = [ordered]@{
        beforeDevCommand = ''
        devUrl = "http://localhost:$devPort/"
    }
    # Match the two --config values passed by pnpm dev:app, including JSON key order.
    $env:TAURI_CONFIG = $devConfig | ConvertTo-Json -Depth 20 -Compress
    try {
        # Tauri CLI dev_options disables default features even when the package has none.
        & (Join-Path $PSScriptRoot 'cargo-slot.ps1') -- cargo build -p openidea --no-default-features
        $prebuildExit = $LASTEXITCODE
    }
    finally {
        Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
    }
    if ($prebuildExit -ne 0) { $devExitCode = $prebuildExit }
    else {
        # The launcher owns the actual Vite listener and session lock.
        Warn-OccupiedDevPorts $devPort
        $env:IBLOPENIDEA_SEED_FROM = $SeedFrom
        Write-Host "Starting $identifier on preferred port $devPort outside the build slot."
        & pnpm dev:app
        $devExitCode = $LASTEXITCODE
    }
}
catch {
    [Console]::Error.WriteLine("[dev:local] $($_.Exception.Message)")
    $devExitCode = 1
}
finally {
    Pop-Location
}
exit $devExitCode
