#!/usr/bin/env bash
# T-008#B-007：造一条与 TECNAI 完全不同的合成语料（多孔板成像），供端到端复跑。
#
#   bash tools/example-profiles/make-corpus.sh [root]
#
# 默认 root = /tmp/annex-gallery-b007，全部产物落在 /tmp —— 绝不写真实 vault。
# 先 rm -rf 该 root，再建 5 张不同形状/尺寸的 PNG，文件名约定为
#   plate<板号>_well<孔位>_<放大倍数>x_<序号>.png   （孔位段可缺省）
set -euo pipefail

ROOT="${1:-/tmp/annex-gallery-b007}"
VAULT="$ROOT/vault"
DIR="$VAULT/20260417-plate-run"

rm -rf "$ROOT"
mkdir -p "$DIR"

magick -size 1024x1024 xc:gray       -depth 8 "$DIR/plate01_wellA3_4000x_007.png"
magick -size 1280x720  xc:steelblue  -depth 8 "$DIR/plate01_wellA3_4000x_008.png"
magick -size 512x512   xc:black      -depth 8 "$DIR/plate02_wellB1_10000x_011.png"
magick -size 800x600   xc:red        -depth 8 "$DIR/plate02_4000x_012.png"          # 没有 well 段
magick -size 300x900   xc:green      -depth 8 "$DIR/plate03_wellC2_2000x_013.png"

# 预设的正文模板按 --vault 解析，所以把示例 .md 放进 vault 的 AnnexGalleryTemplates/。
mkdir -p "$VAULT/AnnexGalleryTemplates"
cp "$(dirname "$0")/plate.md" "$VAULT/AnnexGalleryTemplates/plate.md"
cp "$(dirname "$0")/tecnaitem.md" "$VAULT/AnnexGalleryTemplates/tecnaitem.md"

# 把一个 git 仓库放进 /tmp vault，让 sidecar 的 dirty-file 守卫走真实分支
git -C "$VAULT" init -q -b main

echo "corpus dir: $DIR"
ls -1 "$DIR"
