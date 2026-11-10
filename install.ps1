# dsh-oceaneyes 一键安装脚本
# 作用：把随包分发的 dsh-oceaneyes 插件装进指定的 DSH profile，
#       装完重启 DeepSeek Harness 即生效。
#
# 用法（在本目录打开 PowerShell 运行）：
#   安装到桌面 App 的 profile（默认）：
#     .\install.ps1
#   安装到指定 profile，可多个：
#     .\install.ps1 -Profiles desktop,web
#   卸载：
#     .\install.ps1 -Remove
#
# 原理与 DSH 官方安装方式一致：
#   1. 插件包复制到 %USERPROFILE%\.dsh\plugins\dsh-oceaneyes（长期保存，与下载目录解耦）
#   2. profile 的 package.json 增加 link: 依赖
#   3. profile 的 dsh.profile.bundles 加入包名（patch 层才会被加载）
#   4. profile 的 node_modules 建目录联接（junction）
[CmdletBinding()]
param(
  # 要安装到的 profile 名（desktop = 桌面 App；web = `dsh web` 启动的实例）
  [string[]]$Profiles = @('desktop'),
  # 插件包位置，默认是本脚本旁边的 dsh-oceaneyes 目录
  [string]$Package = (Join-Path $PSScriptRoot 'dsh-oceaneyes'),
  # 卸载而不是安装
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

# ---------- 前置检查 ----------
if (-not (Test-Path (Join-Path $Package 'package.json'))) {
  throw "找不到插件包：$Package（请保持在解压后的完整目录结构中运行本脚本）"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $dshHome 'profiles'
$pluginsRoot = Join-Path $dshHome 'plugins'
$pkgDest = Join-Path $pluginsRoot 'dsh-oceaneyes'

function Get-ProfileBundleList {
  param($Pkg)
  $bundles = $Pkg.dsh.profile.bundles
  if ($null -eq $bundles) { ,@() } else { @($bundles) }
}

function Save-ProfileJson {
  param($Pkg, [string]$Path)
  # UTF-8 无 BOM，npm/pnpm 都接受
  [System.IO.File]::WriteAllText($Path, ($Pkg | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
}

function Sync-Junction {
  param([string]$LinkPath, [string]$TargetPath)
  if (Test-Path $LinkPath) {
    $item = Get-Item $LinkPath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      # 已存在的联接：删掉重建（只删联接本身，不动目标）
      [System.IO.Directory]::Delete($LinkPath, $false)
    } else {
      throw "$LinkPath 已存在且不是目录联接，请手动处理后重试"
    }
  }
  $parent = Split-Path $LinkPath -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
}

if ($Remove) {
  foreach ($name in $Profiles) {
    $profileDir = Join-Path $profilesRoot $name
    if (-not (Test-Path $profileDir)) { Write-Host "跳过：profile $name 不存在"; continue }
    $pkgJsonPath = Join-Path $profileDir 'package.json'
    if (Test-Path $pkgJsonPath) {
      $pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
      if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties['dsh-oceaneyes']) {
        $pkg.dependencies.PSObject.Properties.Remove('dsh-oceaneyes')
      }
      $bundles = Get-ProfileBundleList $pkg
      $kept = @($bundles | Where-Object { $_ -ne 'dsh-oceaneyes' })
      if ($pkg.dsh.profile.bundles) { $pkg.dsh.profile.bundles = $kept }
      Save-ProfileJson $pkg $pkgJsonPath
    }
    $link = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-oceaneyes'
    if (Test-Path $link) {
      $item = Get-Item $link -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [System.IO.Directory]::Delete($link, $false)
      } else {
        Write-Warning "$link 不是联接，未删除，请手动确认"
      }
    }
    Write-Host "已从 profile $name 移除 dsh-oceaneyes"
  }
  Write-Host "卸载完成。重启 DeepSeek Harness 后生效。"
  return
}

# ---------- 安装：先复制包 ----------
New-Item -ItemType Directory -Path $pluginsRoot -Force | Out-Null
if (Test-Path $pkgDest) { Remove-Item $pkgDest -Recurse -Force }
# 只拷贝运行需要的部分（排除 docs 截图，减小体积不是必须，但保持干净）
Copy-Item $Package $pkgDest -Recurse -Force
Write-Host "插件包已复制到 $pkgDest"

$done = @()
foreach ($name in $Profiles) {
  $profileDir = Join-Path $profilesRoot $name
  if (-not (Test-Path $profileDir)) {
    Write-Warning "profile $name 不存在（$profileDir），跳过。先用该 profile 启动一次 DSH 再运行本脚本。"
    continue
  }
  $pkgJsonPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path $pkgJsonPath)) {
    Write-Warning "profile $name 缺少 package.json，跳过。"
    continue
  }

  $pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json

  # 1) 依赖
  if (-not ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties['dsh-oceaneyes'])) {
    if (-not $pkg.dependencies) {
      $pkg | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
    }
    $pkg.dependencies | Add-Member -MemberType NoteProperty -Name 'dsh-oceaneyes' -Value ("link:" + $pkgDest) -Force
  }

  # 2) bundles 列表
  if (-not $pkg.dsh) { $pkg | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{}) }
  if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{}) }
  $bundles = @(Get-ProfileBundleList $pkg)
  if ($bundles -notcontains 'dsh-oceaneyes') {
    $pkg.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value ($bundles + 'dsh-oceaneyes') -Force
  }
  Save-ProfileJson $pkg $pkgJsonPath

  # 3) node_modules 目录联接
  Sync-Junction -LinkPath (Join-Path (Join-Path $profileDir 'node_modules') 'dsh-oceaneyes') -TargetPath $pkgDest

  $done += $name
  Write-Host "profile $name ：安装完成"
}

if ($done.Count -eq 0) {
  throw "没有安装到任何 profile，请检查 -Profiles 参数。"
}

Write-Host ""
Write-Host "全部完成 ✔  装到了：$($done -join ', ')"
Write-Host "重启 DeepSeek Harness（桌面 App 或 dsh web）即可看到开机动画与视频壁纸。"
Write-Host "临时关闭：地址栏加 ?nowallpaper=1，或控制台执行 localStorage['dsh-oceaneyes']='off' 后刷新。"
