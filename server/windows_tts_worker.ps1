Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$synth.SetOutputToNull()

function Emit($message) {
  $message | ConvertTo-Json -Compress
  [Console]::Out.Flush()
}

Emit @{ type = "ready"; engine = "windows-sapi"; voices = $voices }

while ($line = [Console]::In.ReadLine()) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $request = $null
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $request = $line | ConvertFrom-Json
    $text = [string]$request.text
    if ([string]::IsNullOrWhiteSpace($text)) { throw "Text cannot be empty" }
    $options = $request.options
    $voice = [string]$options.voice
    if ($voice -and $voice.Contains("|||")) { $voice = $voice.Split("|||")[0] }
    if ($voice -and $voices -contains $voice) { $synth.SelectVoice($voice) }
    $rate = [double]$options.rate
    if ($rate -le 0) { $rate = 1 }
    $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int][Math]::Round(10 * ($rate - 1))))
    $volume = [double]$options.volume
    if ($volume -ge 0) { $synth.Volume = [Math]::Max(0, [Math]::Min(100, [int][Math]::Round(100 * $volume))) }
    $synth.SetOutputToWaveFile([string]$request.output)
    $synth.Speak($text)
    $synth.SetOutputToNull()
    Emit @{ id = $request.id; ok = $true; engine = "windows-sapi"; durationMs = [int]$started.Elapsed.TotalMilliseconds }
  } catch {
    $synth.SetOutputToNull()
    Emit @{ id = if ($request) { $request.id } else { $null }; ok = $false; error = $_.Exception.Message; durationMs = [int]$started.Elapsed.TotalMilliseconds }
  }
}

$synth.Dispose()
