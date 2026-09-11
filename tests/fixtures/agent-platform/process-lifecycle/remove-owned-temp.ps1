$ErrorActionPreference = 'Stop'

if ($args.Count -lt 2) {
  throw 'TargetRoot and TempRoot positional arguments are required'
}

$TargetRoot = [string]$args[0]
$TempRoot = [string]$args[1]

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

if ([string]::IsNullOrWhiteSpace($TargetRoot) -or [string]::IsNullOrWhiteSpace($TempRoot)) {
  throw 'TargetRoot and TempRoot are required'
}

$tmpFull = Get-FullPath $TempRoot
$rootFull = Get-FullPath $TargetRoot

if (-not [System.IO.Path]::IsPathRooted($rootFull)) {
  throw "TargetRoot must be absolute: $TargetRoot"
}
if (-not [System.IO.Path]::IsPathRooted($tmpFull)) {
  throw "TempRoot must be absolute: $TempRoot"
}

$tmpPrefix = $tmpFull.TrimEnd('\') + '\'
$rootTrim = $rootFull.TrimEnd('\')
if (-not ($rootTrim + '\').StartsWith($tmpPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
    $rootTrim -ne $tmpFull.TrimEnd('\')) {
  throw "Refusing to remove path outside temp root. root=$rootFull tmp=$tmpFull"
}

$current = $rootFull
$stop = $tmpFull
$guard = 0
while ($current -and $guard -lt 64) {
  $guard += 1
  if (Test-Path -LiteralPath $current) {
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to remove reparse point: $current"
    }
  }
  if ($current.TrimEnd('\') -eq $stop.TrimEnd('\')) { break }
  $parent = [System.IO.Path]::GetDirectoryName($current)
  if (-not $parent -or $parent -eq $current) { break }
  $current = $parent
}

if (-not (Test-Path -LiteralPath $rootFull)) { exit 0 }

Remove-Item -LiteralPath $rootFull -Recurse -Force
