# Merge UniDL *.dec.mp4 + *.srt after failed mp4 mux (Kayo: H.264 + AC-3 + subs → MKV).
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$MkvMerge = 'D:\WEB-DL Tools\mkvmerge.exe'
)
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$base = Get-ChildItem -LiteralPath $Dir -Filter '*_01_vid.dec.mp4' | Select-Object -First 1
if (-not $base) { throw "No *_01_vid.dec.mp4 in $Dir" }
$stem = $base.BaseName -replace '_01_vid\.dec$',''
$vid = Join-Path $Dir "${stem}_01_vid.dec.mp4"
$aud = Join-Path $Dir "${stem}_02_aud.dec.mp4"
$sub = Join-Path $Dir "${stem}_03_sub_en.srt"
$out = Join-Path $Dir "$stem.mkv"
if (-not (Test-Path -LiteralPath $aud)) { throw "Missing audio: $aud" }
$args = @('-o', $out, $vid, $aud)
if (Test-Path -LiteralPath $sub) { $args += $sub }
& $MkvMerge @args
