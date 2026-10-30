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
    & (Join-Path $PSScriptRoot 'cargo-slot.ps1') -- pnpm exec vitest run @localTestArguments
    $localTestExit = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine("[test:full] $($_.Exception.Message)")
    $localTestExit = 1
}
finally {
    Pop-Location
}
exit $localTestExit
