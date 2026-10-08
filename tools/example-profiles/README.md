# example-profiles — 配置驱动 metadata 解析的最小复跑套件

与 TECNAI 完全不同的第二条 profile（多孔板成像）及其一键复跑脚本。全部产物落在 `/tmp`，**绝不写真实 vault**。

| 文件 | 作用 |
|---|---|
| `make-corpus.sh` | 造 5 张不同形状/尺寸的合成 PNG（`/tmp/annex-gallery-b007/vault/20260417-plate-run`），并把该 vault `git init` 成仓库。 |
| `plate-profile.json` | profile 本体（`id=platewell`）：正则 `^plate(?<plate>\d+)(?:_well(?<well>[A-Z]\d+))?_(?<magnification>\d+)x_(?<index>\d+)$`。 |
| `two-profiles.json` | 两条带 `match` 的 profile（内置 TECNAI 的电镜版 + 多孔板版），用来演示 `pickProfile` 自动选择。 |
| `verify-frontmatter.cjs` | 逐份断言产出的 frontmatter：键序列 == `keyOrder`（去掉取不到值的 `notes`）、number 裸值、text 双引号、`well` 缺段写空串。 |
| `verify-plugin-load.cjs` | 用 `npm run smoke` 的桩环境加载 `main.js`，把 `platewell` 放进 data.json 的 `profiles` 数组，证明插件读得回且内置 TECNAI 没丢。 |

一键复跑（在仓库根目录，需先 `npm run build`）：

```bash
export PATH="/Users/example/.hermes/tools/node-26.7.0-darwin-arm64/bin:$PATH"
npm run build
bash tools/example-profiles/make-corpus.sh
node tools/annex-gallery.mjs profiles --check --profiles-file tools/example-profiles/plate-profile.json
node tools/annex-gallery.mjs sidecar /tmp/annex-gallery-b007/vault/20260417-plate-run \
  --vault /tmp/annex-gallery-b007/vault --sample plate-demo \
  --profiles-file tools/example-profiles/two-profiles.json --apply
node tools/example-profiles/verify-frontmatter.cjs
node tools/example-profiles/verify-plugin-load.cjs
```

命名约定（5 张图）：`plate<板号>_well<孔位>_<放大倍数>x_<序号>.png`，其中 `plate02_4000x_012.png` **故意不带孔位段**，
用来演示「可选组未命中 ⇒ 写 `whenMissing`（空串）」。
