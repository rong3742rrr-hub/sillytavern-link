$ErrorActionPreference = 'Stop'
$stLinkProject = Split-Path $PSScriptRoot -Parent
$stLinkVersion = ([IO.File]::ReadAllText((Join-Path $stLinkProject 'package.json')) | ConvertFrom-Json).version
$stLinkStage = Join-Path $stLinkProject ("release\$stLinkVersion\sillytavern-link")
$stLinkArchive = Join-Path (Split-Path $stLinkProject -Parent) ("sillytavern link-$stLinkVersion.zip")
if ((Test-Path -LiteralPath $stLinkStage) -or (Test-Path -LiteralPath $stLinkArchive)) { throw 'Release already exists. Preserve it before rebuilding.' }
New-Item -ItemType Directory -Path $stLinkStage -Force | Out-Null
foreach ($folder in @('extension','server','shared','tools')) {
    Copy-Item -LiteralPath (Join-Path $stLinkProject $folder) -Destination (Join-Path $stLinkStage $folder) -Recurse
}
foreach ($name in @('manifest.json','boot.js','.gitignore','Install.cmd','Uninstall.cmd','install.ps1','uninstall.ps1','package.json','package-lock.json','README.md','TESTED.md','LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $stLinkProject $name) -Destination $stLinkStage
}
# Copy the user-facing text instructions without depending on the console's ANSI code page.
Get-ChildItem -LiteralPath $stLinkProject -File -Filter '*.txt' | Copy-Item -Destination $stLinkStage
New-Item -ItemType Directory -Path (Join-Path $stLinkStage 'tests') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $stLinkProject 'tests') -File |
    Where-Object { $_.Extension -in @('.mjs','.ps1') } |
    Copy-Item -Destination (Join-Path $stLinkStage 'tests')
Compress-Archive -LiteralPath $stLinkStage -DestinationPath $stLinkArchive -CompressionLevel Optimal
Write-Output $stLinkArchive
