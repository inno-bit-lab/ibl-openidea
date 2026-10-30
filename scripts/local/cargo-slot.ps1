# Parse manually so both direct invocation and pwsh -File preserve the command's flags.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$slotCount = 2
$slotName = 'Local\ibl-openidea-cargo'
$commandTokens = @($args)
$tokenIndex = 0
$slotHandles = @()
$acquiredSlot = -1
$commandExitCode = 1

try {
    while ($tokenIndex -lt $commandTokens.Count) {
        $token = [string]$commandTokens[$tokenIndex]
        if ($token -eq '--') {
            $tokenIndex++
            break
        }
        if ($token -notin '-Slots', '-Name') { break }
        if ($tokenIndex + 1 -ge $commandTokens.Count) {
            throw "Missing value for $token."
        }
        $value = [string]$commandTokens[$tokenIndex + 1]
        if ($token -eq '-Slots') {
            if (-not [int]::TryParse($value, [ref]$slotCount) -or $slotCount -lt 1 -or $slotCount -gt 64) {
                throw '-Slots must be an integer between 1 and 64.'
            }
        }
        else {
            if ([string]::IsNullOrWhiteSpace($value)) { throw '-Name must not be empty.' }
            $slotName = $value
        }
        $tokenIndex += 2
    }
    if ($tokenIndex -ge $commandTokens.Count) {
        throw 'Usage: cargo-slot.ps1 [-Slots <count>] [-Name <name>] -- <command> [args...]'
    }
    $slotCommand = [string]$commandTokens[$tokenIndex]
    $slotArguments = @($commandTokens | Select-Object -Skip ($tokenIndex + 1))

    . (Join-Path $PSScriptRoot 'env.ps1')

    for ($index = 0; $index -lt $slotCount; $index++) {
        $slotHandles += [System.Threading.Mutex]::new($false, "$slotName-$index")
    }
    Write-Host "[cargo-slot] Waiting for one of $slotCount build slots ($slotName)..."
    try {
        $acquiredSlot = [System.Threading.WaitHandle]::WaitAny([System.Threading.WaitHandle[]]$slotHandles)
    }
    catch [System.Threading.AbandonedMutexException] {
        # WaitAny grants ownership of the abandoned mutex before throwing.
        $acquiredSlot = $_.Exception.MutexIndex
    }
    if ($acquiredSlot -lt 0 -or $acquiredSlot -ge $slotHandles.Count) {
        throw 'The build slot could not be acquired.'
    }
    if (-not $env:CARGO_BUILD_JOBS) {
        $env:CARGO_BUILD_JOBS = [string][Math]::Max(1, [Math]::Floor([Environment]::ProcessorCount / $slotCount))
    }
    Write-Host "[cargo-slot] Acquired slot $acquiredSlot; CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS."
    $LASTEXITCODE = 0
    & $slotCommand @slotArguments
    $commandExitCode = if ($?) { $LASTEXITCODE } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
}
catch {
    [Console]::Error.WriteLine("[cargo-slot] $($_.Exception.Message)")
    $commandExitCode = 1
}
finally {
    if ($acquiredSlot -ge 0 -and $acquiredSlot -lt $slotHandles.Count) {
        $slotHandles[$acquiredSlot].ReleaseMutex()
    }
    foreach ($handle in $slotHandles) { $handle.Dispose() }
}
exit $commandExitCode
