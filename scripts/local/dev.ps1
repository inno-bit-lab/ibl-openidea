param(
    [switch] $FullDebug,
    [string] $SeedFrom,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))

function Get-FreeDevPort([string] $Root) {
    $pathBytes = [Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())
    $pathHash = [Security.Cryptography.SHA256]::HashData($pathBytes)
    $firstPort = 1420 + ([BitConverter]::ToUInt32($pathHash, 0) % 200) * 2
    $addresses = @([Net.IPAddress]::Loopback)
    if ([Net.Sockets.Socket]::OSSupportsIPv6) { $addresses += [Net.IPAddress]::IPv6Loopback }
    if ($env:TAURI_DEV_HOST) { $addresses += [Net.Dns]::GetHostAddresses($env:TAURI_DEV_HOST) }
    $addresses = @($addresses | Sort-Object -Property IPAddressToString -Unique)
    for ($candidate = $firstPort; $candidate -lt 65534; $candidate += 2) {
        try {
            foreach ($port in @($candidate, ($candidate + 1))) {
                foreach ($address in $addresses) {
                    $listener = [Net.Sockets.TcpListener]::new($address, $port)
                    try { $listener.Start() }
                    finally { $listener.Stop() }
                }
            }
            return [int]$candidate
        }
        catch [Net.Sockets.SocketException] {
            # Both the Vite port and its HMR port must be free.
            if ($_.Exception.SocketErrorCode -notin 'AddressAlreadyInUse', 'AccessDenied') { throw }
        }
    }
    throw 'No free TCP port pair is available for the local development server.'
}

Push-Location -LiteralPath $repoRoot
try {
    $gitDirectory = & git rev-parse --absolute-git-dir
    if ($LASTEXITCODE -ne 0) { throw 'The local development script must run inside a Git worktree.' }
    $gitDirectory = [IO.Path]::GetFullPath($gitDirectory)
    $commonDirectory = & git rev-parse --git-common-dir
    if ($LASTEXITCODE -ne 0) { throw 'Could not identify the primary Git checkout.' }
    $commonDirectory = [IO.Path]::GetFullPath($commonDirectory, $repoRoot)
    $slug = if ($gitDirectory -ieq $commonDirectory) { 'main' } else { Split-Path -Leaf $repoRoot }
    $slug = $slug.ToLowerInvariant() -replace '[^a-z0-9-]', '-'
    if (-not $slug) { throw 'The worktree folder name cannot produce an empty profile slug.' }

    $identifier = "it.innobitlab.iblopenidea.dev.$slug"
    if (-not $SeedFrom) {
        $installedIdentifier = 'it.innobitlab.iblopenidea'
        $profileBases = @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'))
        $installedProfile = $profileBases | Where-Object {
            $_ -and (Test-Path -LiteralPath (Join-Path $_ $installedIdentifier) -PathType Container)
        }
        $SeedFrom = if ($installedProfile) { $installedIdentifier } else { 'ai.l0ng.openidea' }
    }
    $devPort = Get-FreeDevPort $repoRoot
    $overlayPath = Join-Path $repoRoot "target/local/tauri.dev.$slug.json"
    $debugInfo = if ($FullDebug) { 'full' } else { 'line-tables-only' }
    Write-Host "Profile: $identifier"
    Write-Host "Port: $devPort (HMR $($devPort + 1))"
    Write-Host "Overlay: $overlayPath"
    Write-Host "OPENIDEA_DEV_PORT=$devPort"
    Write-Host "IBLOPENIDEA_SEED_FROM=$SeedFrom"
    Write-Host "CARGO_PROFILE_DEV_DEBUG=$debugInfo"
    if ($WhatIf) { return }

    . (Join-Path $PSScriptRoot 'env.ps1')
    $env:CARGO_PROFILE_DEV_DEBUG = $debugInfo
    $env:IBLOPENIDEA_SEED_FROM = $SeedFrom
    [IO.Directory]::CreateDirectory((Split-Path -Parent $overlayPath)) | Out-Null
    $overlay = [ordered]@{
        build = [ordered]@{ devUrl = "http://localhost:$devPort" }
        identifier = $identifier
        app = [ordered]@{ withGlobalTauri = $true }
    }
    $overlay | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $overlayPath -Encoding utf8NoBOM
    # Match `tauri dev`'s feature set (--no-default-features) and TAURI_CONFIG env var
    # so the post-slot `tauri dev` launch does not invalidate and recompile openidea.
    $env:TAURI_CONFIG = $overlay | ConvertTo-Json -Depth 4 -Compress
    try {
        & (Join-Path $PSScriptRoot 'cargo-slot.ps1') -- cargo build -p openidea --no-default-features
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
    }

    # Re-check after compilation: another worktree may have started in the meantime.
    $postBuildPort = Get-FreeDevPort $repoRoot
    if ($postBuildPort -ne $devPort) {
        $devPort = $postBuildPort
        $overlay.build.devUrl = "http://localhost:$devPort"
        $overlay | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $overlayPath -Encoding utf8NoBOM
    }
    $env:OPENIDEA_DEV_PORT = [string]$devPort
    Write-Host "Starting $identifier on port $devPort outside the build slot."
    & pnpm tauri dev --config $overlayPath
    $devExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $devExitCode
