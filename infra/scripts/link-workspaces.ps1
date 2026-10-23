# Windows fallback when symlink creation fails (enable Developer Mode for native pnpm links).
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
Set-Location $root
$pkgs = @('contracts', 'sdk', 'ui', 'config-eslint', 'config-typescript')
$targets = @('node_modules\@tendr', 'apps\web\node_modules\@tendr', 'apps\api\node_modules\@tendr', 'packages\sdk\node_modules\@tendr', 'packages\ui\node_modules\@tendr', 'packages\contracts\node_modules\@tendr')

foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  foreach ($p in $pkgs) {
    $dest = Join-Path $t $p
    $src = (Resolve-Path (Join-Path 'packages' $p)).Path
    if (Test-Path $dest) { cmd /c "rmdir `"$dest`"" | Out-Null }
    cmd /c "mklink /J `"$dest`" `"$src`"" | Out-Null
  }
}
Write-Host 'Workspace junctions ready.'
