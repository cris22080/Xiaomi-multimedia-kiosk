param([int]$PollMilliseconds = 3000)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null

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
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($randomStream)
    $memory = [System.IO.MemoryStream]::new()
    $stream.CopyTo($memory)
    $mime = if ($randomStream.ContentType) { $randomStream.ContentType } else { 'image/jpeg' }
    return "data:$mime;base64,$([Convert]::ToBase64String($memory.ToArray()))"
  } catch {
    return $null
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($randomStream) { $randomStream.Dispose() }
    if ($memory) { $memory.Dispose() }
  }
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
