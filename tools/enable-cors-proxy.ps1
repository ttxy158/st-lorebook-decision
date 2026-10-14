# Turn on enableCorsProxy in SillyTavern's config.yaml.
#
# The decision endpoint takes a non-standard request body, so the browser cannot call it
# directly; the plugin borrows SillyTavern's own /proxy route, which ships switched off.
#
# Run directly:  powershell -NoProfile -ExecutionPolicy Bypass -File enable-cors-proxy.ps1
# or just double-click enable-cors-proxy.bat.
# Optional:      ... -File enable-cors-proxy.ps1 -Path C:\path\to\SillyTavern

param([string]$Path)

$ErrorActionPreference = 'Stop'

function Find-Config([string]$start) {
    if (-not $start) { return $null }
    $dir = $start.TrimEnd('\', '/')
    for ($i = 0; $i -lt 12 -and $dir; $i++) {
        $candidate = Join-Path $dir 'config.yaml'
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $dir 'server.js') -PathType Leaf)) {
            return $candidate
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

$target = $null
if ($Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) { $target = Find-Config $Path }
    elseif (Test-Path -LiteralPath $Path -PathType Leaf) { $target = $Path }
}
if (-not $target) { $target = Find-Config $PSScriptRoot }
if (-not $target) {
    Write-Host "Cannot find SillyTavern's config.yaml."
    Write-Host 'Pass the install folder yourself:  enable-cors-proxy.bat C:\path\to\SillyTavern'
    exit 1
}

Write-Host "Config file: $target"

$text = [IO.File]::ReadAllText($target)

if ($text -match '(?m)^enableCorsProxy\s*:\s*true\s*(#.*)?$') {
    Write-Host 'enableCorsProxy is already true. Nothing to change.'
    Write-Host 'If the plugin still reports 403, restart SillyTavern - the config is read once at startup.'
    exit 0
}

$backup = "$target.bak"
Copy-Item -LiteralPath $target -Destination $backup -Force
Write-Host "Backup written: $backup"

if ($text -match '(?m)^enableCorsProxy\s*:') {
    $updated = [regex]::Replace($text, '(?m)^enableCorsProxy\s*:.*\r?$', 'enableCorsProxy: true')
} else {
    $newline = if ($text -match "`r`n") { "`r`n" } else { "`n" }
    $updated = $text.TrimEnd() + $newline + 'enableCorsProxy: true' + $newline
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($target, $updated, $utf8NoBom)

$check = [IO.File]::ReadAllText($target)
if ($check -match '(?m)^enableCorsProxy\s*:\s*true\s*$') {
    Write-Host 'Done. enableCorsProxy is now true.'
    Write-Host 'Restart SillyTavern for it to take effect.'
} else {
    Write-Host 'Rewritten, but the check did not pass. Open the file and look at the enableCorsProxy line.'
    exit 1
}
