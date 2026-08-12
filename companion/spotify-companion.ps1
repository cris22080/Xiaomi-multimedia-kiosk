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
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]

function Await-WinRt($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}

function Get-ArtworkDataUrl($thumbnail) {
  if ($null -eq $thumbnail) { return $null }
  try {
    $randomStream = Await-WinRt ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $randomStream -or $randomStream.Size -le 0) { return $null }
    $reader = [Windows.Storage.Streams.DataReader]::new($randomStream.GetInputStreamAt(0))
    $size = [uint32][math]::Min($randomStream.Size, [uint32]::MaxValue)
    [void](Await-WinRt ($reader.LoadAsync($size)) ([uint32]))
    $bytes = [byte[]]::new($size)
    $reader.ReadBytes($bytes)
    $mime = if ($randomStream.ContentType) { $randomStream.ContentType } else { 'image/jpeg' }
    "data:$mime;base64,$([Convert]::ToBase64String($bytes))"
  } catch {
    Write-Warning "Copertina non leggibile: $($_.Exception.Message)"
    $null
  }
}

function Find-OnlineArtwork([string]$title, [string]$artist) {
  if ([string]::IsNullOrWhiteSpace($title)) { return $null }
  try {
    $term = [uri]::EscapeDataString("$artist $title")
    $result = Invoke-RestMethod `
      -Uri "https://itunes.apple.com/search?term=$term&country=IT&media=music&entity=song&limit=5" `
      -Method Get -TimeoutSec 6
    $match = @($result.results) | Where-Object {
      $_.artworkUrl100 -and (
        $_.trackName -eq $title -or
        $_.artistName -eq $artist
      )
    } | Select-Object -First 1
    if ($null -eq $match) {
      $match = @($result.results) | Where-Object { $_.artworkUrl100 } | Select-Object -First 1
    }
    if ($match.artworkUrl100) {
      # Cambia solo il token delle dimensioni, preservando estensione e query.
      return [regex]::Replace([string]$match.artworkUrl100, '100x100(?:bb|-\d+)?(?=\.)', '600x600bb')
    }
  } catch {
    Write-Warning "Ricerca copertina online fallita: $($_.Exception.Message)"
  }
  return $null
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
        if (-not $lastArtwork) {
          $lastArtwork = Find-OnlineArtwork $properties.Title $properties.Artist
        }
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
