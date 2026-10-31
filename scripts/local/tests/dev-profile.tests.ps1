$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$fixtureRoot = Join-Path $repoRoot "target/local/evidence/dev profile & 张 三 $([Guid]::NewGuid().ToString('N'))"
$fixtureScripts = Join-Path $fixtureRoot 'scripts/local'
[IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
& git init --quiet $fixtureRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not create the primary-checkout test fixture.' }
$fixtureScript = Join-Path $fixtureScripts 'dev.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../dev.ps1') -Destination $fixtureScript
$pwshPath = (Get-Process -Id $PID).Path

function Read-DevSelection([string] $CaseName) {
    $output = & $pwshPath -NoProfile -File $fixtureScript -WhatIf 2>&1
    $output | Set-Content -LiteralPath (Join-Path $fixtureRoot "$CaseName.log")
    if ($LASTEXITCODE -ne 0) { throw "dev -WhatIf failed in $CaseName. Evidence: $fixtureRoot" }
    $text = $output -join "`n"
    if ($text -notmatch '(?m)^Profile: it\.innobitlab\.iblopenidea\.dev\.main\s*$') {
        throw "The primary checkout must use slug main. Evidence: $fixtureRoot"
    }
    $portMatch = [regex]::Match($text, '(?m)^Port: (\d+) \(HMR (\d+)\)')
    if (-not $portMatch.Success) { throw 'The selected dev port was not printed.' }
    $port = [int]$portMatch.Groups[1].Value
    if ([int]$portMatch.Groups[2].Value -ne $port + 1) { throw 'The HMR port must follow the Vite port.' }
    if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'target')) {
        throw '-WhatIf created generated files in the fixture.'
    }
    return $port
}

$baselinePort = Read-DevSelection 'primary'
Write-Output 'PASS: a primary checkout with spaces and Unicode uses slug main; WhatIf writes no generated files.'

if ([Net.Sockets.Socket]::OSSupportsIPv6) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, $baselinePort)
    $listener.Server.DualMode = $false
    try {
        $listener.Start()
        if ((Read-DevSelection 'ipv6-occupied') -lt $baselinePort + 2) {
            throw 'An IPv6-only listener did not make the selected port pair unavailable.'
        }
    }
    finally { $listener.Stop() }
    Write-Output 'PASS: an IPv6-only listener on the Vite port makes the allocator skip that pair.'
}
else { Write-Output 'SKIP: IPv6 is unavailable on this machine.' }

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, ($baselinePort + 1))
try {
    $listener.Start()
    if ((Read-DevSelection 'hmr-occupied') -lt $baselinePort + 2) {
        throw 'An occupied HMR port did not make the selected port pair unavailable.'
    }
}
finally { $listener.Stop() }
Write-Output 'PASS: an occupied HMR port makes the allocator skip that pair.'

$fixtureBin = Join-Path $fixtureRoot 'fake-bin'
[IO.Directory]::CreateDirectory($fixtureBin) | Out-Null
@'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:PATH = (@((Join-Path $fixtureRoot 'fake-bin')) + @($env:PATH -split [IO.Path]::PathSeparator)) -join [IO.Path]::PathSeparator
'@ | Set-Content -LiteralPath (Join-Path $fixtureScripts 'env.ps1') -Encoding utf8NoBOM

@'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
[ordered]@{
    arguments = @($args)
    tauriConfig = $env:TAURI_CONFIG
    debug = $env:CARGO_PROFILE_DEV_DEBUG
    seedFrom = $env:IBLOPENIDEA_SEED_FROM
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $fixtureRoot 'slot-call.json') -Encoding utf8NoBOM
$global:LASTEXITCODE = 0
'@ | Set-Content -LiteralPath (Join-Path $fixtureScripts 'cargo-slot.ps1') -Encoding utf8NoBOM

@'
$fixtureRoot = Split-Path -Parent $PSScriptRoot
[ordered]@{
    arguments = @($args)
    tauriConfig = $env:TAURI_CONFIG
    devPort = $env:OPENIDEA_DEV_PORT
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $fixtureRoot 'pnpm-call.json') -Encoding utf8NoBOM
$global:LASTEXITCODE = 0
'@ | Set-Content -LiteralPath (Join-Path $fixtureBin 'pnpm.ps1') -Encoding utf8NoBOM

$runOutput = & $pwshPath -NoProfile -File $fixtureScript 2>&1
$runOutput | Set-Content -LiteralPath (Join-Path $fixtureRoot 'prebuild-alignment.log')
if ($LASTEXITCODE -ne 0) { throw "dev.ps1 prebuild alignment test failed. Evidence: $fixtureRoot" }
$expectedOverlayPath = Join-Path $fixtureRoot 'target/local/tauri.dev.main.json'
if (-not (Test-Path -LiteralPath $expectedOverlayPath -PathType Leaf)) {
    throw "Expected overlay file was not written: $expectedOverlayPath"
}
$expectedCompactOverlay = '{"build":{"devUrl":"http://localhost:' + $baselinePort + '"},"identifier":"it.innobitlab.iblopenidea.dev.main","app":{"withGlobalTauri":true}}'
$slotCall = Get-Content -LiteralPath (Join-Path $fixtureRoot 'slot-call.json') -Raw | ConvertFrom-Json
if (($slotCall.arguments -join '|') -ne 'cargo|build|-p|openidea|--no-default-features') {
    throw "Unexpected slot prebuild arguments: $($slotCall.arguments -join ' ')"
}
if ($slotCall.tauriConfig -ne $expectedCompactOverlay) {
    throw "Slot prebuild TAURI_CONFIG did not match tauri dev overlay. Got: $($slotCall.tauriConfig)"
}
$pnpmCall = Get-Content -LiteralPath (Join-Path $fixtureRoot 'pnpm-call.json') -Raw | ConvertFrom-Json
if (($pnpmCall.arguments -join '|') -ne "tauri|dev|--config|$expectedOverlayPath") {
    throw "Unexpected pnpm tauri dev arguments: $($pnpmCall.arguments -join ' ')"
}
if ($null -ne $pnpmCall.tauriConfig -and $pnpmCall.tauriConfig -ne '') {
    throw "TAURI_CONFIG must be cleared before invoking pnpm tauri dev, got: $($pnpmCall.tauriConfig)"
}
if ($pnpmCall.devPort -ne [string]$baselinePort) {
    throw "OPENIDEA_DEV_PORT mismatch: expected $baselinePort, got $($pnpmCall.devPort)"
}
Write-Output 'PASS: dev.ps1 prebuilds openidea inside cargo-slot with --no-default-features and matching TAURI_CONFIG.'
Write-Output "Dev profile test evidence: $fixtureRoot"
