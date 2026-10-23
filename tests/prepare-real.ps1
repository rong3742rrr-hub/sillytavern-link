param([Parameter(Mandatory=$true)][string]$SillyTavernPath)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($SillyTavernPath.Trim('"'))
if (-not (Test-Path -LiteralPath (Join-Path $source 'server.js') -PathType Leaf)) { throw 'Not a SillyTavern folder' }
$target = Join-Path $PSScriptRoot 'runtime\SillyTavern-test'
if (Test-Path -LiteralPath $target) { throw 'Test runtime already exists; use it rather than overwrite it' }
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($name in @('src','default')) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $name) -Recurse }
foreach ($name in @('server.js','package.json','webpack.config.js')) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $name) }
New-Item -ItemType Junction -Path (Join-Path $target 'node_modules') -Target (Join-Path $source 'node_modules') | Out-Null
foreach ($relative in @('public','public\scripts','public\scripts\extensions')) {
    $dest = Join-Path $target $relative
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $source $relative) -File | Copy-Item -Destination $dest
    foreach ($dir in (Get-ChildItem -LiteralPath (Join-Path $source $relative) -Directory)) {
        if ($dir.Name -in @('scripts','extensions','third-party')) { continue }
        New-Item -ItemType Junction -Path (Join-Path $dest $dir.Name) -Target $dir.FullName | Out-Null
    }
}
New-Item -ItemType Directory -Path (Join-Path $target 'public\scripts\extensions\third-party') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target 'plugins') | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'default\config.yaml') -Destination (Join-Path $target 'config.yaml')
Write-Output $target
