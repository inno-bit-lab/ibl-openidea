param(
    [switch] $Worker,
    [string] $FixtureRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

if ($Worker) {
    $fixtureBin = Join-Path $FixtureRoot 'fake bin'
    $fixtureEnv = Join-Path $FixtureRoot 'scripts/local/env.ps1'
    $fixtureMarker = Join-Path $FixtureRoot 'node_modules/.modules.yaml'
    $fixtureCalls = Join-Path $FixtureRoot 'pnpm-calls.jsonl'
    # Exclude real package-manager directories so a broken PATH cannot install anything.
    $env:PATH = @($fixtureBin, (Join-Path $env:SystemRoot 'System32'), $env:SystemRoot, $PSHOME) -join [IO.Path]::PathSeparator
    $env:RUSTC_WRAPPER = 'fixture-existing-wrapper'
    $initialLocation = (Get-Location).Path
    $initialPreference = $ErrorActionPreference
    $resolvedPnpm = (Get-Command pnpm -ErrorAction Stop).Source
    Assert-True ($resolvedPnpm -eq (Join-Path $fixtureBin 'pnpm.ps1')) 'The fixture must intercept pnpm before sourcing env.ps1.'
    Assert-True (-not (Test-Path -LiteralPath $fixtureMarker)) 'The regression fixture must begin with an incomplete node_modules directory.'

    . $fixtureEnv

    Assert-True (Test-Path -LiteralPath $fixtureMarker -PathType Leaf) 'An empty node_modules directory must trigger dependency installation.'
    $calls = @(Get-Content -LiteralPath $fixtureCalls | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-True ($calls.Count -eq 1) 'The initial source must invoke pnpm exactly once.'
    Assert-True (($calls[0].arguments -join '|') -eq 'install|--frozen-lockfile|--config.confirmModulesPurge=false') 'Bootstrap must use a frozen lockfile and disable the interactive modules-purge prompt.'
    Assert-True ($calls[0].cwd -eq $FixtureRoot) 'Bootstrap must install in the fixture worktree.'

    . $fixtureEnv

    $calls = @(Get-Content -LiteralPath $fixtureCalls | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-True ($calls.Count -eq 1) 'A complete node_modules marker must skip another installation.'
    Assert-True ($env:RUSTC_WRAPPER -eq 'fixture-existing-wrapper') 'An existing RUSTC_WRAPPER must be preserved.'
    Assert-True ((Get-Location).Path -eq $initialLocation) 'Sourcing env.ps1 must preserve the caller location.'
    Assert-True ($ErrorActionPreference -eq $initialPreference) 'Sourcing env.ps1 must preserve the caller error preference.'
    Assert-True (Test-Path -LiteralPath (Join-Path $FixtureRoot 'dist') -PathType Container) 'Bootstrap must create dist.'
    $linkPath = (& where.exe link.exe | Select-Object -First 1)
    Assert-True ($LASTEXITCODE -eq 0 -and $linkPath -like '*\2022\*') "Expected the VS2022 linker, got '$linkPath'."
    Write-Output 'PASS: incomplete node_modules installs once; the marker skips repeat installation.'
    Write-Output 'PASS: fake pnpm recorded frozen-lockfile, noninteractive purge and the fixture cwd.'
    Write-Output "PASS: caller state and wrapper preserved; VS2022 linker: $linkPath"
    exit 0
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$runRoot = Join-Path $repoRoot ('target/local/evidence/env bootstrap 张 三 ' + [Guid]::NewGuid().ToString('N'))
$fixtureRoot = Join-Path $runRoot 'fixture worktree'
$fixtureLocal = Join-Path $fixtureRoot 'scripts/local'
$fixtureBin = Join-Path $fixtureRoot 'fake bin'
foreach ($directory in @($fixtureLocal, $fixtureBin, (Join-Path $fixtureRoot 'node_modules'))) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/local/env.ps1') -Destination (Join-Path $fixtureLocal 'env.ps1')
@'
$fixtureRoot = Split-Path -Parent $PSScriptRoot
[ordered]@{
    arguments = @($args)
    cwd = (Get-Location).Path
} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $fixtureRoot 'pnpm-calls.jsonl')
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'node_modules/.modules.yaml'), 'fixture: true')
$global:LASTEXITCODE = 0
'@ | Set-Content -LiteralPath (Join-Path $fixtureBin 'pnpm.ps1') -Encoding utf8NoBOM

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Get-Process -Id $PID).Path
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.WorkingDirectory = $repoRoot
foreach ($argument in @('-NoProfile', '-File', $PSCommandPath, '-Worker', '-FixtureRoot', $fixtureRoot)) {
    $start.ArgumentList.Add($argument)
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$null = $process.Start()
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
try {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(1000)) {
        if ($watch.Elapsed.TotalSeconds -ge 180) {
            throw "Environment bootstrap test exceeded 180 seconds. Evidence: $runRoot"
        }
    }
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    $output | Set-Content -LiteralPath (Join-Path $runRoot 'stdout.log')
    $errors | Set-Content -LiteralPath (Join-Path $runRoot 'stderr.log')
    Write-Output $output.TrimEnd()
    Assert-True ($process.ExitCode -eq 0) "Environment bootstrap test failed (exit $($process.ExitCode)). Evidence: $runRoot`n$errors"
    Write-Output "Evidence: $runRoot"
}
finally {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
    $process.Dispose()
}
