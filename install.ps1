#Requires -Version 5.1
<#
  abdm MCP server installer (portable, no admin rights, no Node.js install required).

  It registers tools\abdm\mcp-server.mjs as an MCP stdio server inside the DSH desktop
  profile. The runtime is DSH's OWN bundled Node.js

      <DSH install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe

  so the target machine needs nothing but DSH itself.

  Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
      powershell ... -File install.ps1 -NodePath "C:\Program Files\nodejs\node.exe"
      powershell ... -File install.ps1 -Uninstall
      powershell ... -File install.ps1 -Profile "C:\path\cordis.patch.yml" -WhatIf

  Exit codes: 0 ok, 1 error, 3 verification failed.
#>
[CmdletBinding()]
param(
  [string] $ToolsDir = '',
  [string] $Profile = '',
  [string] $NodePath = '',
  [switch] $Uninstall,
  [switch] $WhatIf,
  [switch] $SkipVerify,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$ServerName = 'abdm'
$Id = 'abdm'

# `$PSScriptRoot` is NOT populated yet when parameter defaults are evaluated under
# `powershell -File`, so resolve the script directory here instead.
if (-not $ToolsDir) {
  $ToolsDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
}
if (-not $ToolsDir) { $ToolsDir = (Get-Location).Path }

function Write-Step($msg) { Write-Host "[abdm] $msg" }
function Fail($msg) { Write-Host "[abdm] ERROR: $msg" -ForegroundColor Red; exit 1 }

if ($env:ABDM_INSTALL_DEBUG) {
  Write-Host "bound: $(($PSBoundParameters.Keys) -join ',')"
  Write-Host "ToolsDir=[$ToolsDir] Profile=[$Profile] NodePath=[$NodePath] Uninstall=$Uninstall WhatIf=$WhatIf SkipVerify=$SkipVerify Force=$Force"
}

# ---------------------------------------------------------------- locate node runtime
function Find-Node {
  param([string]$Explicit)

  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { Fail "node.exe not found: $Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }

  # 1) a node runtime shipped next to this script (fully self-contained package)
  foreach ($c in @((Join-Path $ToolsDir 'runtime\node.exe'), (Join-Path $ToolsDir 'node.exe'))) {
    if (Test-Path -LiteralPath $c) { return $c }
  }

  # 2) DSH's own bundled Node.js — discover it from the running desktop app
  $dshRoots = New-Object System.Collections.Generic.List[string]
  try {
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -match 'deepseek|dsh' } |
      ForEach-Object {
        try { if ($_.Path) { $dshRoots.Add((Split-Path -Parent $_.Path)) } } catch {}
      }
  } catch {}
  if ($env:DSH_HOME) { $dshRoots.Add((Split-Path -Parent $env:DSH_HOME)) }
  foreach ($guess in @('E:\deepseek-harness', 'D:\deepseek-harness',
                       (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
                       (Join-Path $env:ProgramFiles 'DeepSeek Harness'))) {
    if ($guess) { $dshRoots.Add($guess) }
  }
  $rel = 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  foreach ($root in ($dshRoots | Select-Object -Unique)) {
    $c = Join-Path $root $rel
    if (Test-Path -LiteralPath $c) { return $c }
    # fall back to any node.exe under resources\runtime (layout may change between versions)
    $runtime = Join-Path $root 'resources\runtime'
    if (Test-Path -LiteralPath $runtime) {
      $found = Get-ChildItem -LiteralPath $runtime -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Sort-Object Length -Descending | Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  }

  # 3) whatever is on PATH
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  Fail "no Node.js runtime found. Pass -NodePath <path to node.exe>, or ship runtime\node.exe next to this script."
}

# ---------------------------------------------------------------- locate profile file
function Find-Profile {
  param([string]$Explicit)
  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    # allow creating the file when its directory exists (fresh install), reject obvious typos
    $parent = Split-Path -Parent $Explicit
    if ($parent -and (Test-Path -LiteralPath $parent)) {
      Write-Step "profile does not exist yet, will create: $Explicit"
      return $Explicit
    }
    Fail "profile file not found: $Explicit"
  }
  $cands = New-Object System.Collections.Generic.List[string]
  if ($env:DSH_HOME) {
    $cands.Add((Join-Path $env:DSH_HOME 'profiles\desktop\cordis.patch.yml'))
    $cands.Add((Join-Path $env:DSH_HOME 'profiles\web\cordis.patch.yml'))
  }
  foreach ($home2 in @('E:\dsh-home', (Join-Path $env:USERPROFILE '.dsh'), (Join-Path $env:APPDATA 'dsh'))) {
    if ($home2) {
      $cands.Add((Join-Path $home2 'profiles\desktop\cordis.patch.yml'))
      $cands.Add((Join-Path $home2 'profiles\web\cordis.patch.yml'))
    }
  }
  foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path } }

  # nothing found: create one under DSH_HOME (or ~/.dsh) for the desktop profile
  $base = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $p = Join-Path $base 'profiles\desktop\cordis.patch.yml'
  Write-Step "no profile found, will create: $p"
  return $p
}

# ---------------------------------------------------------------- verify the server speaks MCP
function Test-Server {
  param([string]$Node, [string]$Server)
  if (-not (Test-Path -LiteralPath $Server)) { return @{ ok = $false; why = "server file missing: $Server" } }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = '"' + $Server + '"'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # the server never needs the caller's DSH internals
  $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')

  $p = $null
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"abdm-install","version":"1"}}}')
    $p.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
    $p.StandardInput.Flush()

    $deadline = (Get-Date).AddSeconds(20)
    $buffer = ''
    while ((Get-Date) -lt $deadline) {
      $task = $p.StandardOutput.ReadLineAsync()
      if (-not $task.Wait(3000)) { continue }
      $line = $task.Result
      if ($null -eq $line) { break }
      $buffer += $line
      if ($buffer -match '"id":2') { break }
    }
    if ($buffer -notmatch '"id":2') {
      $err = ''
      try { if (-not $p.HasExited) { $p.Kill() } } catch {}
      return @{ ok = $false; why = 'server did not answer tools/list within 20s' }
    }
    $tools = @()
    foreach ($m in [regex]::Matches($buffer, '"name":"((?:abdm|mcp)[a-z_]*)')) { $tools += $m.Groups[1].Value }
    return @{ ok = $true; tools = ($tools | Select-Object -Unique) }
  } catch {
    return @{ ok = $false; why = "$($_.Exception.Message)" }
  } finally {
    try { if ($p -and -not $p.HasExited) { $p.Kill() } } catch {}
  }
}

# ---------------------------------------------------------------- yaml block helpers
function New-Block([string]$node, [string]$server) {
  # NOTE: build every line with interpolation. `'a' + $b, 'c'` parses as `'a' + ($b, 'c')`
  # in PowerShell (comma binds tighter), which silently injects newlines into the YAML.
  $nl = "`r`n"
  $lines = @(
    '- insert:'
    "    - id: $Id"
    '      name: "@deepseek-ai/dsh-mcp-client"'
    '      config:'
    "        serverName: $ServerName"
    '        transport: stdio'
    "        command: '$node'"
    "        args: [ '$server' ]"
    '        failOnStartupError: false'
  )
  return ($lines -join $nl)
}

function Remove-Block([string]$text) {
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $i = 0
  $removed = 0
  while ($i -lt $lines.Count) {
    if ($lines[$i] -match ('^\s*-?\s*id:\s*' + [regex]::Escape($Id) + '\s*$')) {
      # walk back to the '- insert:' line that starts this block
      $start = $out.Count - 1
      while ($start -ge 0 -and $out[$start] -notmatch '^-\s') { $start-- }
      if ($start -ge 0 -and $out[$start] -match '^-\s*insert') {
        while ($out.Count -gt $start) { $out.RemoveAt($out.Count - 1) }
      }
      $i++
      while ($i -lt $lines.Count -and $lines[$i] -notmatch '^-\s') { $i++ }
      $removed++
      continue
    }
    $out.Add($lines[$i])
    $i++
  }
  return @{ text = ($out -join "`r`n"); removed = $removed }
}

# ---------------------------------------------------------------- main
$node = ''
$server = Join-Path $ToolsDir 'mcp-server.mjs'
$engine = Join-Path $ToolsDir 'engine.mjs'
$profilePath = Find-Profile $Profile

if (-not (Test-Path -LiteralPath $server)) { Fail "mcp-server.mjs not found in $ToolsDir" }
if (-not (Test-Path -LiteralPath $engine)) { Fail "engine.mjs not found in $ToolsDir" }

$existing = ''
if (Test-Path -LiteralPath $profilePath) { $existing = [IO.File]::ReadAllText($profilePath) }

if ($Uninstall) {
  $r = Remove-Block $existing
  if ($r.removed -eq 0) { Write-Step "nothing to remove from $profilePath"; exit 0 }
  if ($WhatIf) { Write-Step "would remove $($r.removed) block(s) from $profilePath"; exit 0 }
  Copy-Item -LiteralPath $profilePath -Destination ($profilePath + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
  [IO.File]::WriteAllText($profilePath, $r.text, (New-Object Text.UTF8Encoding($false)))
  Write-Step "removed $($r.removed) block(s). Restart the DSH desktop app to drop the tools."
  exit 0
}

$node = Find-Node $NodePath
Write-Step "node:    $node"
Write-Step "server:  $server"
Write-Step "profile: $profilePath"

if (-not $SkipVerify) {
  Write-Step 'verifying runtime + server handshake ...'
  $v = Test-Server -Node $node -Server $server
  if (-not $v.ok) { Fail "verification failed: $($v.why)" }
  Write-Step ('verify ok, tools: ' + (($v.tools | Sort-Object) -join ', '))
}

$hasBlock = $existing -match ('(?m)^\s*-?\s*id:\s*' + [regex]::Escape($Id) + '\s*$')
$block = New-Block $node $server

if ($hasBlock -and -not $Force) {
  Write-Step "profile already contains id: $Id - leaving it alone (use -Force to rewrite it)"
  Write-Step 'Restart the DSH desktop app if the tools are still missing.'
  exit 0
}

$newText = $existing
if ($hasBlock) {
  $r = Remove-Block $existing
  $newText = $r.text
}

$sep = if ($newText.Trim().Length -gt 0) { "`r`n" } else { '' }
$newText = $newText.TrimEnd("`r", "`n")
if ($newText.Length -gt 0) { $newText += "`r`n" }
$newText += $block + "`r`n"

if ($WhatIf) {
  Write-Step 'would write:'
  Write-Host $block
  exit 0
}

if (Test-Path -LiteralPath $profilePath) {
  Copy-Item -LiteralPath $profilePath -Destination ($profilePath + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilePath) | Out-Null
}
[IO.File]::WriteAllText($profilePath, $newText, (New-Object Text.UTF8Encoding($false)))

Write-Step 'installed.'
Write-Host ''
Write-Host 'Next: restart the DSH desktop app, then ask the agent to run:'
Write-Host '  abdm_status            (shows engine + ABDM state)'
Write-Host '  abdm_download(url=["https://.../file.zip"], outDir="C:\tmp\dl")'
Write-Host ''
Write-Host ("To undo: powershell -NoProfile -ExecutionPolicy Bypass -File `"" + $PSCommandPath + "`" -Uninstall")
exit 0
