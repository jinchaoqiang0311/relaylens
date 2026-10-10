# publish-ghpages.ps1 - Publish dist-relay to GitHub Pages (gh-pages branch)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File publish-ghpages.ps1
# Prereq: node build-relay.js must have been run first.
$ErrorActionPreference = 'Stop'

$root = 'c:\Users\Administrator\Desktop\relaylens'
$dist = Join-Path $root 'dist-relay'
$tmp  = Join-Path $env:TEMP 'relaylens-ghpages'
$remote = 'git@github.com:jinchaoqiang0311/relaylens.git'

# 0) preflight: structure + secret scan
$bad = 0
Get-ChildItem (Join-Path $dist '*.html') | ForEach-Object {
  $h = [System.IO.File]::ReadAllText($_.FullName)
  $idx = $h.IndexOf('</html>')
  $residual = if ($idx -ge 0) { $h.Substring($idx + 7).Trim() } else { 'NO-CLOSING-TAG' }
  $o = [regex]::Matches($h, '<script\b').Count
  $c = [regex]::Matches($h, '</script>').Count
  if (($residual -is [string] -and $residual.Length -gt 0) -or $o -ne $c -or -not $h.TrimEnd().EndsWith('</html>')) {
    $bad++; Write-Output ("BAD page: " + $_.Name)
  }
}
$sk = 0; $pem = 0
Get-ChildItem $dist -Recurse -File -Include *.html,*.js,*.css,*.json,*.txt,*.xml,*.svg,*.md | ForEach-Object {
  $txt = [System.IO.File]::ReadAllText($_.FullName)
  $sk += ([regex]::Matches($txt, 'sk-[A-Za-z0-9]{20,}')).Count
  $pem += ([regex]::Matches($txt, '-----BEGIN [A-Z ]*PRIVATE KEY-----')).Count
}
$opsLeak = Test-Path (Join-Path $dist 'ops.html')
Write-Output ("preflight: badPages=" + $bad + " sk=" + $sk + " pem=" + $pem + " opsLeak=" + $opsLeak)
if ($bad -gt 0 -or $sk + $pem -gt 0 -or $opsLeak) { throw 'preflight FAILED, abort publish' }

# 1) stage clean tree
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
Copy-Item (Join-Path $dist '*') $tmp -Recurse
New-Item -ItemType File -Path (Join-Path $tmp '.nojekyll') | Out-Null

# 2) commit gh-pages
Set-Location $tmp
git init -q -b gh-pages
git add -A
git -c user.name='relaylens' -c user.email='relaylens@local' commit -q -m ("publish dist-relay " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))

# 3) push (git writes progress to stderr; do NOT let PS 5.1 turn that into a terminating error)
# gh-pages 每次由 dist-relay 全量重建、历史不连续,必须 force;该分支是纯构建产物,force 是安全的。
# ⚠ 此做法仅限 gh-pages,严禁对 master/main 使用。
if (-not (git remote)) { git remote add origin $remote }
$ErrorActionPreference = 'Continue'
$pushOut = cmd /c "git push --force origin gh-pages 2>&1"
$pushOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
$pushOut | Select-Object -Last 4 | ForEach-Object { $_.ToString() }
if (-not $pushOk) { throw 'git push failed' }
# verify remote branch updated
$ref = git ls-remote origin refs/heads/gh-pages
Write-Output ('remote gh-pages -> ' + $ref)
Write-Output ('published gh-pages @ ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
