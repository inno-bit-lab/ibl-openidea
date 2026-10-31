$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$slotScript = Join-Path $repoRoot 'scripts/local/cargo-slot.ps1'
if (-not (Test-Path -LiteralPath $slotScript -PathType Leaf)) {
    throw "The slot wrapper is missing: $slotScript"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'scripts/local/env.ps1') -PathType Leaf)) {
    throw 'The local environment script is missing: scripts/local/env.ps1'
}
. (Join-Path $repoRoot 'scripts/local/env.ps1')

$pwshPath = (Get-Process -Id $PID).Path
$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $repoRoot "target/local/evidence/slot tests 张 三 $runId"
$null = New-Item -ItemType Directory -Path $runRoot -Force
$children = [Collections.Generic.List[object]]::new()

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Start-SlotProcess([string] $CaseName, [string] $MutexName, [string[]] $CommandArguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $pwshPath
    $start.WorkingDirectory = $repoRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', $slotScript, '-Slots', '1', '-Name', $MutexName, '--') + $CommandArguments) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $null = $process.Start()
    # Read stdout one line at a time so tests can observe the post-bootstrap slot barrier.
    # Stderr is drained independently to prevent a full pipe from blocking a child.
    $child = [pscustomobject]@{
        Name = $CaseName
        Process = $process
        StdoutRead = $process.StandardOutput.ReadLineAsync()
        StdoutLines = [Collections.Generic.List[string]]::new()
        Stderr = $process.StandardError.ReadToEndAsync()
    }
    $children.Add($child)
    return $child
}

function Receive-ProcessOutput($Child) {
    while ($null -ne $Child.StdoutRead -and $Child.StdoutRead.IsCompleted) {
        $line = $Child.StdoutRead.GetAwaiter().GetResult()
        if ($null -eq $line) {
            $Child.StdoutRead = $null
        } else {
            $Child.StdoutLines.Add($line)
            $Child.StdoutRead = $Child.Process.StandardOutput.ReadLineAsync()
        }
    }
}

function Save-ProcessOutput($Child) {
    Receive-ProcessOutput $Child
    if ($Child.Process.HasExited) {
        $drainWatch = [Diagnostics.Stopwatch]::StartNew()
        while (($null -ne $Child.StdoutRead -or -not $Child.Stderr.IsCompleted) -and $drainWatch.ElapsedMilliseconds -lt 5000) {
            Receive-ProcessOutput $Child
            Start-Sleep -Milliseconds 10
        }
    }
    $Child.StdoutLines | Set-Content -LiteralPath (Join-Path $runRoot "$($Child.Name).stdout.log")
    if ($Child.Stderr.IsCompleted) {
        $Child.Stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $runRoot "$($Child.Name).stderr.log")
    }
}

function Wait-OutputBarrier($Child, [string] $Pattern, [int] $TimeoutMilliseconds = 120000) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Receive-ProcessOutput $Child
        if ($Child.StdoutLines | Where-Object { $_ -match $Pattern }) { return }
        if ($Child.Process.HasExited) {
            Save-ProcessOutput $Child
            throw "$($Child.Name) exited before output barrier '$Pattern'. Logs: $runRoot"
        }
        if ($watch.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
            throw "$($Child.Name) did not reach output barrier '$Pattern' within $TimeoutMilliseconds ms."
        }
        Start-Sleep -Milliseconds 25
    } while ($true)
}

function Wait-Child($Child, [int] $TimeoutMilliseconds = 120000, [int] $ExpectedExitCode = 0) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $Child.Process.HasExited) {
        Receive-ProcessOutput $Child
        Assert-True ($watch.ElapsedMilliseconds -lt $TimeoutMilliseconds) "$($Child.Name) did not finish within $TimeoutMilliseconds ms."
        Start-Sleep -Milliseconds 25
    }
    Save-ProcessOutput $Child
    Assert-True ($Child.Process.ExitCode -eq $ExpectedExitCode) "$($Child.Name) exited with $($Child.Process.ExitCode), expected $ExpectedExitCode. Logs: $runRoot"
}

function Wait-Marker([string] $Path, $Child, [int] $TimeoutMilliseconds = 120000) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Receive-ProcessOutput $Child
        if ($Child.Process.HasExited) {
            Save-ProcessOutput $Child
            throw "$($Child.Name) exited before creating its marker. Logs: $runRoot"
        }
        if ($watch.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
            throw "$($Child.Name) did not create $Path within $TimeoutMilliseconds ms."
        }
        Start-Sleep -Milliseconds 25
    }
    # File existence can become visible before the writer closes the file.
    do {
        try {
            $marker = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
            if ($null -ne $marker -and $null -ne $marker.ticks) { return $marker }
            throw "The marker is empty: $Path"
        } catch {
            if ($watch.ElapsedMilliseconds -ge $TimeoutMilliseconds) { throw }
            Start-Sleep -Milliseconds 25
        }
    } while ($true)
}

$commandScript = Join-Path $runRoot 'timed command.ps1'
@'
param([string] $StartPath, [string] $EndPath, [int] $Milliseconds, [string] $ReleasePath)
$ErrorActionPreference = 'Stop'
@{ pid = $PID; ticks = [DateTime]::UtcNow.Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath $StartPath
if ($ReleasePath) {
    $releaseWatch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $ReleasePath -PathType Leaf)) {
        if ($releaseWatch.ElapsedMilliseconds -ge 120000) { throw 'Timed out waiting for the command release marker.' }
        Start-Sleep -Milliseconds 25
    }
}
Start-Sleep -Milliseconds $Milliseconds
@{ pid = $PID; ticks = [DateTime]::UtcNow.Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath $EndPath
'@ | Set-Content -LiteralPath $commandScript

try {
    $mutexName = "Local\ibl-openidea-test-$runId-serial"
    $firstStart = Join-Path $runRoot 'first start.json'
    $firstEnd = Join-Path $runRoot 'first end.json'
    $secondStart = Join-Path $runRoot 'second start.json'
    $secondEnd = Join-Path $runRoot 'second end.json'
    $releaseFirst = Join-Path $runRoot 'release first.json'
    $first = Start-SlotProcess 'serial-first' $mutexName @($pwshPath, '-NoProfile', '-File', $commandScript, $firstStart, $firstEnd, '3000', $releaseFirst)
    $null = Wait-Marker $firstStart $first
    $second = Start-SlotProcess 'serial-second' $mutexName @($pwshPath, '-NoProfile', '-File', $commandScript, $secondStart, $secondEnd, '3000')
    Wait-OutputBarrier $second '\[cargo-slot\] Waiting'
    Assert-True (-not (Test-Path -LiteralPath $secondStart)) 'The second command entered while the first command held the slot behind its release marker.'
    [IO.File]::WriteAllText($releaseFirst, 'release')
    Wait-Child $first
    Wait-Child $second
    $firstStarted = Get-Content -LiteralPath $firstStart -Raw | ConvertFrom-Json
    $firstEnded = Get-Content -LiteralPath $firstEnd -Raw | ConvertFrom-Json
    $secondStarted = Get-Content -LiteralPath $secondStart -Raw | ConvertFrom-Json
    $secondEnded = Get-Content -LiteralPath $secondEnd -Raw | ConvertFrom-Json
    Assert-True (($firstEnded.ticks -le $secondStarted.ticks) -or ($secondEnded.ticks -le $firstStarted.ticks)) 'Commands overlapped while sharing one slot.'
    Write-Output 'PASS: one slot serializes two independent processes; command paths and arguments contain spaces and Unicode.'

    $mutexName = "Local\ibl-openidea-test-$runId-abandoned"
    $holderStart = Join-Path $runRoot 'holder start.json'
    $holderEnd = Join-Path $runRoot 'holder end.json'
    $waiterStart = Join-Path $runRoot 'waiter start.json'
    $waiterEnd = Join-Path $runRoot 'waiter end.json'
    $holder = Start-SlotProcess 'abandoned-holder' $mutexName @($pwshPath, '-NoProfile', '-File', $commandScript, $holderStart, $holderEnd, '300000')
    Wait-OutputBarrier $holder '\[cargo-slot\] Acquired'
    $null = Wait-Marker $holderStart $holder
    $waiter = Start-SlotProcess 'abandoned-waiter' $mutexName @($pwshPath, '-NoProfile', '-File', $commandScript, $waiterStart, $waiterEnd, '100')
    Wait-OutputBarrier $waiter '\[cargo-slot\] Waiting'
    Assert-True (-not (Test-Path -LiteralPath $waiterStart)) 'The waiter entered while the holder owned the slot.'
    Assert-True (-not $waiter.Process.HasExited) 'The waiter failed before the holder was killed.'
    $recoveryWatch = [Diagnostics.Stopwatch]::StartNew()
    $holder.Process.Kill($true)
    Assert-True ($holder.Process.WaitForExit(5000)) 'The killed holder did not exit.'
    $remainingMilliseconds = [Math]::Max(1, 5000 - [int]$recoveryWatch.ElapsedMilliseconds)
    Wait-OutputBarrier $waiter '\[cargo-slot\] Acquired' $remainingMilliseconds
    $recoveryMilliseconds = $recoveryWatch.ElapsedMilliseconds
    Assert-True ($recoveryMilliseconds -lt 5000) "The waiter took $recoveryMilliseconds ms to acquire an abandoned slot."
    $null = Wait-Marker $waiterStart $waiter
    Assert-True (-not (Test-Path -LiteralPath $holderEnd)) 'The holder completed normally instead of being killed.'
    Save-ProcessOutput $holder
    Wait-Child $waiter
    Write-Output "PASS: killed holder releases its slot; waiter acquired after $recoveryMilliseconds ms."

    $exitProcess = Start-SlotProcess 'exit-code' "Local\ibl-openidea-test-$runId-exit" @($pwshPath, '-NoProfile', '-Command', 'exit 7')
    Wait-Child $exitProcess 120000 7
    Write-Output 'PASS: pwsh -NoProfile -File cargo-slot.ps1 -Slots 1 -- pwsh -Command "exit 7" returns 7.'
    Write-Output "All 3 cargo-slot tests passed. Evidence: $runRoot"
} finally {
    foreach ($child in $children) {
        try {
            if (-not $child.Process.HasExited) {
                $child.Process.Kill($true)
                $null = $child.Process.WaitForExit(5000)
            }
            Save-ProcessOutput $child
        } catch {
            # Cleanup failures must preserve the original assertion or timeout.
            Write-Warning "Could not finish cleanup for $($child.Name): $($_.Exception.Message)"
        } finally {
            $child.Process.Dispose()
        }
    }
}
