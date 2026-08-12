param(
    [Parameter(Mandatory = $true)]
    [string]$SketchFile
)

$utf8 = [System.Text.UTF8Encoding]::new($false)
$windows1252 = [System.Text.Encoding]::GetEncoding(1252)
$text = [System.IO.File]::ReadAllText($SketchFile, $utf8)

# Ripara una singola doppia interpretazione: UTF-8 letto come Windows-1252.
$fixed = $utf8.GetString($windows1252.GetBytes($text))

[System.IO.File]::WriteAllText($SketchFile, $fixed, $utf8)
Write-Host "Codifica UTF-8 ripristinata in $SketchFile"
