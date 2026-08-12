$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Cozy Desk Spotify Companion.lnk'
if (Test-Path -LiteralPath $shortcut) {
  Remove-Item -LiteralPath $shortcut
  Write-Host 'Avvio automatico rimosso.'
} else {
  Write-Host 'Il collegamento di avvio automatico non era presente.'
}
