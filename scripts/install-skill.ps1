<#
.SYNOPSIS
  把本仓库的 skills/firefox-bidi-mcp 挂进 DSH 的 skills 目录（junction，无需管理员）。

.DESCRIPTION
  skill 跟着 MCP 仓库走 —— 源只有一份（skills/firefox-bidi-mcp），
  DSH 看到的是 junction。改了仓库里的 SKILL.md，DSH 侧立刻就是新的，不用复制。

.PARAMETER DshHome
  DSH 实例的 HOME，默认取环境变量 DSH_HOME。

.PARAMETER Uninstall
  删掉 junction（只删链接，不动仓库里的源）。

.EXAMPLE
  pwsh scripts/install-skill.ps1
  pwsh scripts/install-skill.ps1 -Uninstall
#>
param(
  [string]$DshHome = $env:DSH_HOME,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if (-not $DshHome) { throw '请设置 DSH_HOME，或用 -DshHome 指定' }
if (-not (Test-Path $DshHome)) { throw "DSH_HOME 不存在: $DshHome" }

$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo 'skills/firefox-bidi-mcp'
if (-not (Test-Path $src)) { throw "源目录不存在: $src" }

$skillsDir = Join-Path $DshHome 'skills'
$dst = Join-Path $skillsDir 'firefox-bidi-mcp'

if ($Uninstall) {
  if (Test-Path $dst) {
    $item = Get-Item $dst -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
      cmd /c rmdir "$dst" 2>$null
      if (Test-Path $dst) { throw "删除失败: $dst" }
      Write-Output "已移除 junction: $dst"
    } else {
      Write-Output "跳过：$dst 是真实目录，不是 junction（请手动确认后删除）"
    }
  } else {
    Write-Output "未安装：$dst 不存在"
  }
  exit 0
}

if (-not (Test-Path $skillsDir)) { New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null }

if (Test-Path $dst) {
  $item = Get-Item $dst -Force
  if ($item.LinkType -eq 'Junction') {
    Write-Output "已存在 junction，检查目标..."
    if ($item.Target -eq $src -or $item.Target -contains $src) {
      Write-Output "目标正确，无需改动: $dst -> $src"
      exit 0
    }
    Write-Output "目标不对（$($item.Target)），重建"
    cmd /c rmdir "$dst" 2>$null
  } else {
    throw "$dst 已存在且不是 junction（可能是旧的手工副本），请先确认并移除"
  }
}

cmd /c mklink /J "$dst" "$src" | Out-Null
if (-not (Test-Path $dst)) { throw 'junction 创建失败' }

Write-Output "已安装: $dst -> $src"
Write-Output ''
Write-Output '验证：'
Get-ChildItem $dst -Recurse -File | ForEach-Object { Write-Output ('  ' + $_.FullName.Replace($dst, 'browser-mcp')) }
