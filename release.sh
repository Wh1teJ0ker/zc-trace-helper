#!/usr/bin/env zsh
# 本地发布脚本：./release.sh 1.0.1
# 1) 校验 manifest.json 版本一致 2) 提交所有改动 3) 打 tag 推送（CI 自动打包发 Release）
set -euo pipefail

VER="${1:?用法: ./release.sh <版本号，如 1.0.1>}"

cd "$(dirname "$0")"

# 与 manifest.json 版本一致性校验
MV=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
if [ "$VER" != "$MV" ]; then
  echo "✗ manifest.json version=$MV 与要发布的 $VER 不一致"
  echo "  先更新 manifest.json 的 version 字段，再运行本脚本"
  exit 1
fi

git add -A
if git diff --cached --quiet; then
  echo "· 无待提交改动"
else
  git -c user.name="Wh1teJ0ker" -c user.email="1430100306@qq.com" commit -m "release: v$VER"
fi

git tag "v$VER"
git push origin main "v$VER"
echo "✓ 已推送 tag v$VER — CI 将自动创建 Release 并附上扩展 zip"
echo "  https://github.com/Wh1teJ0ker/zc-trace-helper/actions"
