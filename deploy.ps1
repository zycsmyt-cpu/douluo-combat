# deploy.ps1 —— 一条命令搞定：部署到 TauriTavern + 提交推送 GitHub
#
# 用法：
#   .\deploy.ps1                       自动生成 commit 信息
#   .\deploy.ps1 -Msg "修了克制表"     自定义 commit 信息
#   .\deploy.ps1 -NoPush               只提交不推送
#   .\deploy.ps1 -SkipDeploy           只推 git 不拷文件
#   .\deploy.ps1 -SkipGit              只拷文件不碰 git
#
# 注意：以 pwsh -File deploy.ps1 方式运行，别在交互式会话里 dot-source。

param(
    [string]$Msg = "",
    [switch]$NoPush,
    [switch]$SkipDeploy,
    [switch]$SkipGit
)

$ErrorActionPreference = 'Stop'
$src = 'X:\dsh  xingge\douluo-combat'
$dst = 'X:\tt\extensions\third-party\douluo-combat'
$files = @('data.js', 'engine.js', 'index.js', 'manifest.json', 'parser.js', 'README.md', 'style.css')

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# ---------- 1. 部署到 TauriTavern ----------
if (-not $SkipDeploy) {
    if (-not (Test-Path $dst)) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Say "[deploy] 新建目录 $dst" 'Yellow'
    }
    $n = 0
    foreach ($f in $files) {
        $s = Join-Path $src $f
        if (Test-Path $s) {
            Copy-Item $s -Destination $dst -Force
            $n++
        } else {
            Say "[deploy] 缺文件 $f，跳过" 'Yellow'
        }
    }
    Say "[deploy] 已拷 $n 个文件 → $dst" 'Green'
} else {
    Say '[deploy] 跳过（-SkipDeploy）' 'DarkGray'
}

if ($SkipGit) {
    Say '[git] 跳过（-SkipGit）' 'DarkGray'
    exit 0
}

# ---------- 2. 提交推送 ----------
Set-Location $src

$changed = git status --porcelain
$ahead = 0
try { $ahead = [int](git rev-list --count '@{u}..HEAD' 2>$null) } catch { $ahead = 0 }

if (-not $changed -and $ahead -le 0) {
    Say '[git] 没有改动，也不用推送' 'Yellow'
    exit 0
}

if ($changed) {
    Say "[git] 改动：" 'Gray'
    $changed | Select-Object -First 20 | ForEach-Object { Say "    $_" 'DarkGray' }
    $more = @($changed).Count - 20
    if ($more -gt 0) { Say "    ……还有 $more 项" 'DarkGray' }

    if (-not $Msg) { $Msg = "chore: 更新 $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }

    git add -A
    git commit -m $Msg | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Say '[git] 提交失败' 'Red'
        exit 1
    }
    Say "[git] 已提交：$Msg" 'Green'
} else {
    Say "[git] 工作区干净，但有 $ahead 个提交没推" 'Yellow'
}

if ($NoPush) {
    Say '[git] 跳过推送（-NoPush）' 'DarkGray'
    exit 0
}

git push 2>&1 | ForEach-Object { Say "    $_" 'DarkGray' }
if ($LASTEXITCODE -ne 0) {
    Say '[git] 推送失败，检查网络或凭证' 'Red'
    exit 1
}
Say '[git] 已推送' 'Green'

$head = git log --oneline -1
Say "完成 → $head" 'Cyan'
