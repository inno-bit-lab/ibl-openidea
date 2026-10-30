# pnpm keeps a separator passed after the script name; cargo needs only its own arguments.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$localTestExit = 1
$localTestArguments = @($args)
if ($localTestArguments.Count -gt 0 -and $localTestArguments[0] -eq '--') {
    $localTestArguments = @($localTestArguments | Select-Object -Skip 1)
}
$localRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location -LiteralPath $localRepoRoot
try {
    & (Join-Path $PSScriptRoot 'cargo-slot.ps1') -- cargo test @localTestArguments
    $localTestExit = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine("[test:rust] $($_.Exception.Message)")
    $localTestExit = 1
}
finally {
    Pop-Location
}
exit $localTestExit
