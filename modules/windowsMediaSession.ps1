param([int]$PollMilliseconds = 3000)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]

function Await-WinRt($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  return $task.GetAwaiter().GetResult()
}

function Get-Manager {
  Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Get-ArtworkDataUrl($thumbnail) {
  if ($null -eq $thumbnail) { return $null }
  try {
    $randomStream = Await-WinRt ($thumbnail.OpenReadAsync()) `
      ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $randomStream -or $randomStream.Size -le 0) { return $null }
    $reader = [Windows.Storage.Streams.DataReader]::new($randomStream.GetInputStreamAt(0))
    $size = [uint32][math]::Min($randomStream.Size, [uint32]::MaxValue)
    [void](Await-WinRt ($reader.LoadAsync($size)) ([uint32]))
    $bytes = [byte[]]::new($size)
    $reader.ReadBytes($bytes)
    $mime = if ($randomStream.ContentType) { $randomStream.ContentType } else { 'image/jpeg' }
    return "data:$mime;base64,$([Convert]::ToBase64String($bytes))"
  } catch {
    [Console]::Error.WriteLine("Copertina non leggibile: $($_.Exception.Message)")
    return $null
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
      $_.artworkUrl100 -and ($_.trackName -eq $title -or $_.artistName -eq $artist)
    } | Select-Object -First 1
    if ($null -eq $match) {
      $match = @($result.results) | Where-Object { $_.artworkUrl100 } | Select-Object -First 1
    }
    if ($match.artworkUrl100) {
      # Cambia solo il token delle dimensioni, preservando estensione e query.
      return [regex]::Replace([string]$match.artworkUrl100, '100x100(?:bb|-\d+)?(?=\.)', '600x600bb')
    }
  } catch {
    [Console]::Error.WriteLine("Ricerca copertina online fallita: $($_.Exception.Message)")
  }
  return $null
}

$manager = $null
$lastJson = ''
$lastMediaKey = ''
$lastArtwork = $null

while ($true) {
  try {
    if ($null -eq $manager) { $manager = Get-Manager }
    $sessions = @($manager.GetSessions())
    $session = $sessions | Where-Object {
      $_.SourceAppUserModelId -match '(?i)spotify'
    } | Select-Object -First 1
    if ($null -eq $session) { $session = $manager.GetCurrentSession() }

    if ($null -eq $session) {
      $json = 'null'
    } else {
      $properties = Await-WinRt ($session.TryGetMediaPropertiesAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $playback = $session.GetPlaybackInfo()
      $timeline = $session.GetTimelineProperties()
      $mediaKey = "$($session.SourceAppUserModelId)|$($properties.Title)|$($properties.Artist)|$($properties.AlbumTitle)"
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
        device = [ordered]@{ id = 'windows-local'; name = 'Questo PC'; type = 'Computer' }
        autoDisplay = $playback.PlaybackStatus.ToString() -eq 'Playing'
        deviceMatches = $true
        localSession = $true
      }
      $json = $payload | ConvertTo-Json -Compress -Depth 4
    }

    if ($json -ne $lastJson) {
      [Console]::Out.WriteLine($json)
      [Console]::Out.Flush()
      $lastJson = $json
    }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $manager = $null
  }
  Start-Sleep -Milliseconds ([math]::Max(1000, $PollMilliseconds))
}
