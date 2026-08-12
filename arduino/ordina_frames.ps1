param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [string]$OutputFile = (Join-Path $PSScriptRoot 'frames_ordinati.h')
)

$text = Get-Content -Raw -LiteralPath $InputFile
$pattern = "(?ms)//\s*'frame_(\d+)_delay-0'.*?^\};"
$matches = [regex]::Matches($text, $pattern)

if ($matches.Count -eq 0) {
    throw 'Nessun frame riconosciuto nel file di input.'
}

$frames = foreach ($match in $matches) {
    [pscustomobject]@{
        Index = [int]$match.Groups[1].Value
        Code  = $match.Value.Trim()
    }
}

$duplicates = $frames | Group-Object Index | Where-Object Count -gt 1
if ($duplicates) {
    throw "Indici duplicati: $($duplicates.Name -join ', ')"
}

$array = [regex]::Match(
    $text,
    '(?ms)const unsigned char\*\s+epd_bitmap_allArray\[\d+\]\s*=\s*\{.*?^\};'
)

if (-not $array.Success) {
    throw 'Array epd_bitmap_allArray non trovato.'
}

$ordered = $frames | Sort-Object Index
$content = @(
    '// File generato da ordina_frames.ps1: frame ordinati numericamente.'
    ''
    ($ordered.Code -join "`r`n`r`n")
    ''
    $array.Value.Trim()
    ''
) -join "`r`n"

Set-Content -LiteralPath $OutputFile -Value $content -Encoding utf8
Write-Host "Creato $OutputFile con $($ordered.Count) frame ordinati."
