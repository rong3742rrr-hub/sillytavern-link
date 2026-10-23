param([string]$SillyTavernPath)
$ErrorActionPreference = 'Stop'
if (-not $SillyTavernPath) {
    $candidate = Get-Item -LiteralPath $PSScriptRoot
    while ($candidate) {
        if ((Test-Path -LiteralPath (Join-Path $candidate.FullName 'server.js') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate.FullName 'config.yaml') -PathType Leaf)) {
            $SillyTavernPath = $candidate.FullName
            break
        }
        $candidate = $candidate.Parent
    }
}
if (-not $SillyTavernPath) { $SillyTavernPath = Read-Host 'SillyTavern folder' }
$stLinkRoot = [IO.Path]::GetFullPath($SillyTavernPath.Trim('"'))
$htmlPath = Join-Path $stLinkRoot 'public\index.html'
if (-not (Test-Path -LiteralPath (Join-Path $stLinkRoot 'server.js')) -or -not (Test-Path -LiteralPath $htmlPath)) { throw 'Not a SillyTavern installation' }
Set-Location -LiteralPath $stLinkRoot
$backup = Join-Path $stLinkRoot ('backups\sillytavern-link-uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $htmlPath -Destination (Join-Path $backup 'index.html')
$html = [IO.File]::ReadAllText($htmlPath)
$html = $html.Replace('<!-- sillytavern link: i18n is loaded after browser data -->','<script type="module" src="scripts/i18n.js"></script>')
$html = $html.Replace('<script type="module" src="scripts/extensions/third-party/sillytavern-link/boot.js"></script>','<script type="module" src="script.js"></script>')
[IO.File]::WriteAllText($htmlPath,$html,(New-Object Text.UTF8Encoding($false)))
foreach ($relative in @('public\scripts\extensions\third-party\sillytavern-link','plugins\sillytavern-link')) {
    $target = [IO.Path]::GetFullPath((Join-Path $stLinkRoot $relative))
    if (-not $target.StartsWith($stLinkRoot.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped installation folder' }
    if (Test-Path -LiteralPath $target) {
        $name = if ($relative.StartsWith('plugins')) { 'server' } else { 'extension' }
        Move-Item -LiteralPath $target -Destination (Join-Path $backup $name)
    }
}
Write-Output "Uninstalled. Recoverable files: $backup"
Write-Output 'Restart SillyTavern. Browser data and all synchronization backups have been kept.'
