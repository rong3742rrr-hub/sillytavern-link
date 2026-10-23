param([string]$SillyTavernPath)
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if (-not $SillyTavernPath) {
    $candidate = Get-Item -LiteralPath $packageRoot
    while ($candidate) {
        if ((Test-Path -LiteralPath (Join-Path $candidate.FullName 'server.js') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate.FullName 'config.yaml') -PathType Leaf)) {
            $SillyTavernPath = $candidate.FullName
            break
        }
        $candidate = $candidate.Parent
    }
}
if (-not $SillyTavernPath) { $SillyTavernPath = Read-Host 'SillyTavern folder (contains server.js)' }
$stLinkRoot = [IO.Path]::GetFullPath($SillyTavernPath.Trim().Trim('"')).TrimEnd('\')
$utf8 = New-Object Text.UTF8Encoding($false)

# Validate the host, configuration and source before making any changes.
foreach ($required in @('server.js','package.json','public\index.html','config.yaml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stLinkRoot $required) -PathType Leaf)) { throw "Not a SillyTavern installation: $required missing" }
}
$version = ([IO.File]::ReadAllText((Join-Path $stLinkRoot 'package.json')) | ConvertFrom-Json).version
if ($version -ne '1.19.0') { throw "This build was verified for SillyTavern 1.19.0; found $version. No files changed." }
$linkVersion = ([IO.File]::ReadAllText((Join-Path $packageRoot 'package.json')) | ConvertFrom-Json).version
foreach ($required in @('extension\manifest.json','extension\index.js','extension\boot.js','extension\engine.mjs','extension\storage.mjs','extension\model.mjs','extension\style.css','server\index.mjs','server\store.mjs','server\retention.mjs','server\model.mjs','server\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $required) -PathType Leaf)) { throw "Incomplete SillyTavern Link package: $required missing. No files changed." }
}
$extensionTarget = [IO.Path]::GetFullPath((Join-Path $stLinkRoot 'public\scripts\extensions\third-party\sillytavern-link'))
$serverTarget = [IO.Path]::GetFullPath((Join-Path $stLinkRoot 'plugins\sillytavern-link'))
$inPlace = $packageRoot.Equals($extensionTarget, [StringComparison]::OrdinalIgnoreCase)
foreach ($target in @($extensionTarget,$serverTarget)) {
    if (-not $target.StartsWith($stLinkRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped installation folder' }
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Extension/plugin targets must be regular directories, not links. No files changed.'
    }
}
if ($packageRoot.StartsWith((Join-Path $stLinkRoot 'data') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Per-user extension installs are not supported. Remove that extension and reinstall with Install for all users checked. No files changed.'
}
if (-not $inPlace -and (Test-Path -LiteralPath (Join-Path $extensionTarget '.git'))) {
    throw 'A Git-managed extension already exists. Update it in SillyTavern, then run Install.cmd inside that installed extension folder. No files changed.'
}
if ($inPlace) {
    $manifest = [IO.File]::ReadAllText((Join-Path $packageRoot 'manifest.json')) | ConvertFrom-Json
    if ($manifest.js -ne 'extension/index.js' -or -not (Test-Path -LiteralPath (Join-Path $packageRoot 'boot.js') -PathType Leaf)) {
        throw 'Invalid repository layout. Restore the root manifest.json and boot.js before setup. No files changed.'
    }
}
$htmlPath = Join-Path $stLinkRoot 'public\index.html'
$html = [IO.File]::ReadAllText($htmlPath)
$originalI18n = '<script type="module" src="scripts/i18n.js"></script>'
$originalMain = '<script type="module" src="script.js"></script>'
$linkI18n = '<!-- sillytavern link: i18n is loaded after browser data -->'
$linkMain = '<script type="module" src="scripts/extensions/third-party/sillytavern-link/boot.js"></script>'
$ordinaryEntry = $html.Contains($originalI18n) -and $html.Contains($originalMain)
$linkEntry = $html.Contains($linkI18n) -and $html.Contains($linkMain)
if (-not $ordinaryEntry -and -not $linkEntry) { throw 'Unknown HTML entry points. No files changed.' }
$configPath = Join-Path $stLinkRoot 'config.yaml'
$config = [IO.File]::ReadAllText($configPath)
$pluginOption = '(?m)^enableServerPlugins:[ \t]*(true|false)[ \t]*(?:#[^\r\n]*)?\r?$'
if ([regex]::Matches($config,$pluginOption).Count -ne 1) { throw 'Expected one enableServerPlugins: true/false option in config.yaml. No files changed.' }
$newConfig = [regex]::Replace($config,'(?m)^(enableServerPlugins:[ \t]*)false(?=[ \t\r]*(?:#|$))','$1true')

$backup = Join-Path $stLinkRoot ('backups\sillytavern-link-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $htmlPath -Destination (Join-Path $backup 'index.html')
Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'config.yaml')
foreach ($pair in @(@('extension',$extensionTarget),@('server',$serverTarget))) {
    if (Test-Path -LiteralPath $pair[1]) { Copy-Item -LiteralPath $pair[1] -Destination (Join-Path $backup $pair[0]) -Recurse -Force }
}
if (-not (Test-Path -LiteralPath (Join-Path $backup 'index.html')) -or -not (Test-Path -LiteralPath (Join-Path $backup 'config.yaml'))) { throw 'Backup failed' }

# Keep the repository's root manifest and boot loader unchanged for future git pulls.
if (-not $inPlace) {
    New-Item -ItemType Directory -Path $extensionTarget -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $packageRoot 'extension') -File | Copy-Item -Destination $extensionTarget -Force
}
New-Item -ItemType Directory -Path $serverTarget -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $packageRoot 'server') -File | Copy-Item -Destination $serverTarget -Force
[IO.File]::WriteAllText($htmlPath,$html.Replace($originalI18n,$linkI18n).Replace($originalMain,$linkMain),$utf8)
if ($newConfig -ne $config) { [IO.File]::WriteAllText($configPath,$newConfig,$utf8) }
[IO.File]::WriteAllText((Join-Path $backup 'install-info.json'), (@{ version=$linkVersion; target=$stLinkRoot; backup=$backup; mode=$(if ($inPlace) { 'repository' } else { 'standalone' }); installedAt=(Get-Date).ToString('o') } | ConvertTo-Json),$utf8)
Write-Output "Installed SillyTavern Link $linkVersion into: $stLinkRoot"
Write-Output "Original startup/config backup: $backup"
if ($inPlace) { Write-Output 'GitHub repository files were left unchanged. After extension updates, run this installer again to update the server component.' }
Write-Output 'Restart SillyTavern once, then reload the browser pages. Existing synchronization data is retained; do not reinitialize an existing baseline.'

