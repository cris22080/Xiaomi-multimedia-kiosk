param(
  [Parameter(Mandatory = $true)]
  [string]$CozyDeskUrl,
  [string]$Token = 'cozy-desk-lan-media'
)

$ErrorActionPreference = 'Stop'
$url = $CozyDeskUrl.TrimEnd('/')
if ($url -notmatch '^https?://[^/]+(?::\d+)?$') {
  throw 'Usa un indirizzo come http://192.168.1.50:4848'
}

$settings = [ordered]@{
  cozyDeskUrl = $url
  token = $Token
  pollingIntervalMs = 3000
}
$settingsPath = Join-Path $PSScriptRoot 'companion-settings.json'
$settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Cozy Desk Spotify Companion.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'spotify-companion.ps1')`""
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host "Configurazione salvata in $settingsPath"
Write-Host "Avvio automatico creato: $shortcutPath"
Write-Host 'Avvio del companion...'
Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
