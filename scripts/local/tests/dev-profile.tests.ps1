$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$fixtureRoot = Join-Path $repoRoot "target/local/evidence/dev profile & 张 三 $([Guid]::NewGuid().ToString('N'))"
$fixtureScripts = Join-Path $fixtureRoot 'scripts/local'
$fixtureBin = Join-Path $fixtureRoot 'fake-bin'
$fixtureRoaming = Join-Path $fixtureRoot 'roaming'
$fixtureLocal = Join-Path $fixtureRoot 'local'
$fixtureTauri = Join-Path $fixtureRoot 'src-tauri'
foreach ($directory in @($fixtureScripts, $fixtureBin, $fixtureRoaming, $fixtureLocal, $fixtureTauri)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}
$fixtureScript = Join-Path $fixtureScripts 'dev.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../dev.ps1') -Destination $fixtureScript
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/dev-session.ts') -Destination (Join-Path $fixtureRoot 'scripts/dev-session.ts')
Copy-Item -LiteralPath (Join-Path $repoRoot 'src-tauri/tauri.dev.conf.json') -Destination (Join-Path $fixtureTauri 'tauri.dev.conf.json')
$pwshPath = (Get-Process -Id $PID).Path
$selectionQuery = "import { worktreeId, worktreeRoot, preferredVitePort } from './scripts/dev-session.ts'; const id = worktreeId(worktreeRoot); console.log(JSON.stringify({ id, port: preferredVitePort(id) }))"

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "$Message Evidence: $fixtureRoot" }
}

function Read-LauncherSelection([string] $Root) {
    Push-Location -LiteralPath $Root
    try {
        $output = & node --input-type=module -e $selectionQuery
        Assert-True ($LASTEXITCODE -eq 0) 'The upstream identity helper must run.'
        return $output | ConvertFrom-Json
    }
    finally { Pop-Location }
}

function Invoke-DevFixture([string] $CaseName, [string[]] $DevArguments, [int] $ExpectedExit = 0, [int] $SlotExit = 0, [int] $AppExit = 0) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $pwshPath
    $start.WorkingDirectory = $fixtureRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['APPDATA'] = $fixtureRoaming
    $start.Environment['LOCALAPPDATA'] = $fixtureLocal
    $start.Environment['FIXTURE_SLOT_EXIT'] = [string]$SlotExit
    $start.Environment['FIXTURE_APP_EXIT'] = [string]$AppExit
    foreach ($argument in @('-NoProfile', '-File', $fixtureScript) + $DevArguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) {
            $process.Kill($true)
            throw "dev.ps1 fixture exceeded 60 seconds in $CaseName."
        }
        $text = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        $text | Set-Content -LiteralPath (Join-Path $fixtureRoot "$CaseName.log") -Encoding utf8NoBOM
        Assert-True ($process.ExitCode -eq $ExpectedExit) "Unexpected dev.ps1 exit in ${CaseName}: $($process.ExitCode), wanted $ExpectedExit."
        return $text
    }
    finally { $process.Dispose() }
}

function Assert-Selection([string] $Text, [object] $Expected, [string] $Seed = 'ai.l0ng.openidea', [string] $Debug = 'line-tables-only') {
    Assert-True ($Text -match "(?m)^Profile: $([regex]::Escape($Expected.id))\s*$") 'The profile must match worktreeId(worktreeRoot).'
    Assert-True ($Text -match "(?m)^Port: $($Expected.port) \(check also $([int]$Expected.port + 1)\)\s*$") 'The preferred port must match preferredVitePort.'
    Assert-True ($Text -match "(?m)^IBLOPENIDEA_SEED_FROM=$([regex]::Escape($Seed))\s*$") 'The selected seed is wrong.'
    Assert-True ($Text -match "(?m)^CARGO_PROFILE_DEV_DEBUG=$Debug\s*$") 'The selected debug level is wrong.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'target'))) '-WhatIf must not create generated files.'
}

$expected = Read-LauncherSelection $fixtureRoot
Assert-Selection (Invoke-DevFixture 'legacy-default' @('-WhatIf')) $expected
[IO.Directory]::CreateDirectory((Join-Path $fixtureLocal 'it.innobitlab.iblopenidea')) | Out-Null
Assert-Selection (Invoke-DevFixture 'local-default' @('-WhatIf')) $expected 'it.innobitlab.iblopenidea'
Remove-Item -LiteralPath (Join-Path $fixtureLocal 'it.innobitlab.iblopenidea')
[IO.Directory]::CreateDirectory((Join-Path $fixtureRoaming 'it.innobitlab.iblopenidea')) | Out-Null
Assert-Selection (Invoke-DevFixture 'roaming-default' @('-WhatIf')) $expected 'it.innobitlab.iblopenidea'
Assert-Selection (Invoke-DevFixture 'explicit-full' @('-WhatIf', '-SeedFrom', 'fixture.explicit', '-FullDebug')) $expected 'fixture.explicit' 'full'
Write-Output 'PASS: Node identity and preferred port match; legacy, Local, Roaming and explicit seeds work with fake profile directories.'
Write-Output 'PASS: -WhatIf writes no generated files; -FullDebug selects full debug information.'

# Fakes record the process contract; no native build or app runs in these tests.
@'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:PATH = (Join-Path $fixtureRoot 'fake-bin') + [IO.Path]::PathSeparator + $env:PATH
'@ | Set-Content -LiteralPath (Join-Path $fixtureScripts 'env.ps1') -Encoding utf8NoBOM
@'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
[ordered]@{
    arguments = @($args)
    tauriConfig = $env:TAURI_CONFIG
    debug = $env:CARGO_PROFILE_DEV_DEBUG
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $fixtureRoot 'slot-call.json') -Encoding utf8NoBOM
$global:LASTEXITCODE = [int]$env:FIXTURE_SLOT_EXIT
'@ | Set-Content -LiteralPath (Join-Path $fixtureScripts 'cargo-slot.ps1') -Encoding utf8NoBOM
@'
$fixtureRoot = Split-Path -Parent $PSScriptRoot
[ordered]@{
    arguments = @($args)
    tauriConfig = $env:TAURI_CONFIG
    seedFrom = $env:IBLOPENIDEA_SEED_FROM
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $fixtureRoot 'pnpm-call.json') -Encoding utf8NoBOM
$global:LASTEXITCODE = [int]$env:FIXTURE_APP_EXIT
'@ | Set-Content -LiteralPath (Join-Path $fixtureBin 'pnpm.ps1') -Encoding utf8NoBOM

$null = Invoke-DevFixture 'prebuild-alignment' @('-SeedFrom', 'fixture.explicit')
$slotCall = Get-Content -LiteralPath (Join-Path $fixtureRoot 'slot-call.json') -Raw | ConvertFrom-Json
Assert-True (($slotCall.arguments -join '|') -eq 'cargo|build|-p|openidea|--no-default-features') 'The slot must receive the matching package and feature flags.'
$expectedConfig = '{"app":{"withGlobalTauri":true},"build":{"beforeDevCommand":"","devUrl":"http://localhost:' + $expected.port + '/"}}'
Assert-True ($slotCall.tauriConfig -eq $expectedConfig) 'The prebuild TAURI_CONFIG must match the merged launcher overlays.'
Assert-True ($slotCall.debug -eq 'line-tables-only') 'The prebuild must use line-tables-only by default.'
$pnpmCall = Get-Content -LiteralPath (Join-Path $fixtureRoot 'pnpm-call.json') -Raw | ConvertFrom-Json
Assert-True (($pnpmCall.arguments -join '|') -eq 'dev:app') 'The app must start through upstream pnpm dev:app.'
Assert-True ([string]::IsNullOrEmpty($pnpmCall.tauriConfig)) 'TAURI_CONFIG must be cleared before the launcher starts.'
Assert-True ($pnpmCall.seedFrom -eq 'fixture.explicit') 'The selected seed must reach the launcher.'
Write-Output 'PASS: matching prebuild flags/config run in the slot; dev:app starts afterwards with the seed and no TAURI_CONFIG.'

Remove-Item -LiteralPath (Join-Path $fixtureRoot 'pnpm-call.json')
$null = Invoke-DevFixture 'prebuild-fails' @() -ExpectedExit 7 -SlotExit 7
Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'pnpm-call.json'))) 'A failed prebuild must not launch the app.'
$null = Invoke-DevFixture 'app-exit' @() -ExpectedExit 23 -AppExit 23
Write-Output 'PASS: a failed prebuild stops launch and preserves its exit code; the launcher exit code is preserved.'

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, ([int]$expected.port + 1))
try {
    $listener.Start()
    $occupied = Invoke-DevFixture 'occupied-neighbour-port' @()
    Assert-True ($occupied -match 'strictPort=false') 'An occupied neighbour port must warn about the possible launcher fallback.'
    Assert-True ($occupied -match "Profile: $([regex]::Escape($expected.id))") 'Port contention must not replace the upstream identity.'
}
finally { $listener.Stop() }
Write-Output 'PASS: an occupied adjacent port warns without allocating a separate port or identity.'
Write-Output "Dev profile test evidence: $fixtureRoot"
