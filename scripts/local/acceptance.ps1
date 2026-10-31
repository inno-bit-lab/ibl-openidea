param([switch] $Start)

$ErrorActionPreference = 'Stop'
$localRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$localInstallers = [IO.Path]::GetFullPath((Join-Path $localRepoRoot 'target/release/bundle/nsis'))
$localOutputDirectory = Join-Path $localRepoRoot 'target/local'
$localSandboxPath = Join-Path $localOutputDirectory 'acceptance.wsb'
[IO.Directory]::CreateDirectory($localOutputDirectory) | Out-Null

$localXmlSettings = [Xml.XmlWriterSettings]::new()
$localXmlSettings.Indent = $true
$localXmlSettings.Encoding = [Text.UTF8Encoding]::new($false)
$localXmlWriter = [Xml.XmlWriter]::Create($localSandboxPath, $localXmlSettings)
try {
    $localXmlWriter.WriteStartDocument()
    $localXmlWriter.WriteStartElement('Configuration')
    $localXmlWriter.WriteStartElement('MappedFolders')
    $localXmlWriter.WriteStartElement('MappedFolder')
    $localXmlWriter.WriteElementString('HostFolder', $localInstallers)
    $localXmlWriter.WriteElementString('SandboxFolder', 'C:\installers')
    $localXmlWriter.WriteElementString('ReadOnly', 'true')
    $localXmlWriter.WriteEndElement()
    $localXmlWriter.WriteEndElement()
    $localXmlWriter.WriteStartElement('LogonCommand')
    $localXmlWriter.WriteElementString('Command', 'explorer.exe C:\installers')
    $localXmlWriter.WriteEndElement()
    $localXmlWriter.WriteEndElement()
    $localXmlWriter.WriteEndDocument()
}
finally {
    $localXmlWriter.Dispose()
}

Write-Output $localSandboxPath
if ($Start) {
    if (-not $IsWindows) { throw 'Windows Sandbox requires Windows.' }
    if (-not (Test-Path -LiteralPath $localInstallers -PathType Container)) {
        throw "The installer directory does not exist: $localInstallers. Run pnpm build:local first."
    }
    $localSandboxStart = [Diagnostics.ProcessStartInfo]::new()
    $localSandboxStart.FileName = $localSandboxPath
    $localSandboxStart.UseShellExecute = $true
    [Diagnostics.Process]::Start($localSandboxStart) | Out-Null
}
