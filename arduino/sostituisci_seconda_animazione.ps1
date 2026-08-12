param(
    [string]$SketchFile = (Join-Path $PSScriptRoot 'domotica_esp32.ino'),
    [string]$FramesFile = (Join-Path $PSScriptRoot 'frames_ordinati.h')
)

$sketch = Get-Content -Raw -LiteralPath $SketchFile
$frames = Get-Content -Raw -LiteralPath $FramesFile

$declarationPattern = "(?ms)//[^\r\n]*\r?\nconst unsigned char epd_bitmap1_frame_\d+_delay_0\s*\[\]\s*PROGMEM\s*=\s*\{.*?^\};\r?\n?"
$oldDeclarations = [regex]::Matches($sketch, $declarationPattern)
if ($oldDeclarations.Count -eq 0) {
    throw 'Dichiarazioni della seconda animazione non trovate.'
}

$arrayPattern = '(?ms)const unsigned char\*\s+epd_bitmap1_allArray\[\d+\]\s*=\s*\{.*?^\};\r?\n?'
if (-not [regex]::IsMatch($sketch, $arrayPattern)) {
    throw 'Array della seconda animazione non trovato.'
}

$newFrameCount = [regex]::Matches(
    $frames,
    'const unsigned char epd_bitmap_frame_\d+_delay_0\s*\[\]\s*PROGMEM'
).Count
if ($newFrameCount -eq 0) {
    throw 'Il file dei nuovi frame non contiene bitmap valide.'
}

# I nomi della seconda animazione hanno il prefisso bitmap1 per non entrare
# in conflitto con la prima animazione già presente nello sketch.
$frames = $frames -replace '(?m)^// File generato.*\r?\n\r?\n', ''
$frames = $frames -replace 'epd_bitmap_frame_', 'epd_bitmap1_frame_'
$frames = $frames -replace 'epd_bitmap_allArray', 'epd_bitmap1_allArray'

$sketch = [regex]::Replace($sketch, $declarationPattern, '')
$sketch = [regex]::Replace($sketch, $arrayPattern, '')

$marker = 'const int NUMERO_FRAME_ANIMAZIONE = '
$markerPosition = $sketch.IndexOf($marker)
if ($markerPosition -lt 0) {
    throw 'Punto di inserimento dei frame non trovato.'
}

$sketch = $sketch.Insert($markerPosition, $frames.Trim() + "`r`n`r`n")
$sketch = [regex]::Replace(
    $sketch,
    'const int NUMERO_FRAME_ANIMAZIONE1\s*=\s*\d+\s*;',
    "const int NUMERO_FRAME_ANIMAZIONE1 = $newFrameCount;"
)

Set-Content -LiteralPath $SketchFile -Value $sketch -Encoding utf8
Write-Host "Seconda animazione sostituita: $newFrameCount frame."
