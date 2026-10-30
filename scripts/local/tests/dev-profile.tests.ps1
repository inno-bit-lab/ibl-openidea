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
Write-Output "Dev profile test evidence: $fixtureRoot"
