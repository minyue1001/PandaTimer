#!/usr/bin/env bash
# 下載 GitHub Actions 最新一次成功編出的 IPA，放到固定資料夾、只留一個檔：
#   C:\Users\minyue\Downloads\PandaTimer\PandaTimer-v<runtimeVersion>-<commit前7碼>.ipa
# 用法：bash scripts/fetch-ipa.sh [run-id]   （不帶 run-id＝最新一次成功的 run）
set -euo pipefail
REPO=minyue1001/PandaTimer
DEST=/mnt/c/Users/minyue/Downloads/PandaTimer
cd /home/minyue/PandaTimer

RUN=${1:-$(gh run list -R "$REPO" --status success -L 1 --json databaseId --jq '.[0].databaseId')}
SHA=$(gh run view "$RUN" -R "$REPO" --json headSha --jq .headSha)
VER=$(git show "$SHA:app.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).expo.runtimeVersion||"x"))')
NAME="PandaTimer-v${VER}-${SHA:0:7}.ipa"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN" -R "$REPO" -D "$TMP"
IPA=$(find "$TMP" -name '*.ipa' | head -1)
[ -n "$IPA" ] || { echo "❌ run $RUN 沒有 IPA"; exit 1; }

mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +   # 清掉舊版，只留新檔
cp "$IPA" "$DEST/$NAME"
echo "✅ $(wslpath -w "$DEST/$NAME")（$(du -h "$DEST/$NAME" | cut -f1)，run $RUN）"
