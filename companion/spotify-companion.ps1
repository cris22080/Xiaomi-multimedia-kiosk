param(
  [string]$SettingsFile = (Join-Path $PSScriptRoot 'companion-settings.json')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path -LiteralPath $SettingsFile)) {
  throw "Configurazione non trovata: $SettingsFile. Esegui prima install-autostart.ps1."
}
$settings = Get-Content -Raw -LiteralPath $SettingsFile | ConvertFrom-Json
$endpoint = "$($settings.cozyDeskUrl.TrimEnd('/'))/media-session"
$headers = @{ 'x-cozy-token' = $settings.token }
$pollMs = [math]::Max(1000, [int]$settings.pollingIntervalMs)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]

function Await-WinRt($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}

function Get-ArtworkDataUrl($thumbnail) {
  if ($null -eq $thumbnail) { return $null }
  $randomStream = $null; $stream = $null; $memory = $null
  try {
    $randomStream = Await-WinRt ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($randomStream)
    $memory = [System.IO.MemoryStream]::new()
    $stream.CopyTo($memory)
    $mime = if ($randomStream.ContentType) { $randomStream.ContentType } else { 'image/jpeg' }
    "data:$mime;base64,$([Convert]::ToBase64String($memory.ToArray()))"
  } catch { $null } finally {
    if ($stream) { $stream.Dispose() }
    if ($randomStream) { $randomStream.Dispose() }
    if ($memory) { $memory.Dispose() }
  }
}

$manager = $null; $lastMediaKey = ''; $lastArtwork = $null
while ($true) {
  try {
    if ($null -eq $manager) {
      $manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    $session = @($manager.GetSessions()) | Where-Object {
      $_.SourceAppUserModelId -match '(?i)spotify'
    } | Select-Object -First 1

    if ($null -eq $session) {
      $body = 'null'
    } else {
      $properties = Await-WinRt ($session.TryGetMediaPropertiesAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $playback = $session.GetPlaybackInfo()
      $timeline = $session.GetTimelineProperties()
      $mediaKey = "$($properties.Title)|$($properties.Artist)|$($properties.AlbumTitle)"
      if ($mediaKey -ne $lastMediaKey) {
        $lastArtwork = Get-ArtworkDataUrl $properties.Thumbnail
        $lastMediaKey = $mediaKey
      }
      $payload = [ordered]@{
        source = $session.SourceAppUserModelId
        title = $properties.Title
        artists = $properties.Artist
        album = $properties.AlbumTitle
        albumArt = $lastArtwork
        isPlaying = $playback.PlaybackStatus.ToString() -eq 'Playing'
        progressMs = [math]::Max(0, [int64]$timeline.Position.TotalMilliseconds)
        durationMs = [math]::Max(0, [int64]$timeline.EndTime.TotalMilliseconds)
        device = @{ id = 'windows-companion'; name = $env:COMPUTERNAME; type = 'Computer' }
      }
      $body = $payload | ConvertTo-Json -Compress -Depth 4
    }
    Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5 > $null
  } catch {
    Write-Warning $_.Exception.Message
    if ($_.Exception.Message -match 'servizio|service|WinRT') { $manager = $null }
  }
  Start-Sleep -Milliseconds $pollMs
}
