# example-profiles — 配置驱动 metadata 解析的最小复跑套件

两条互不相同的预设（TECNAI 电镜 + 多孔板成像）及其一键复跑脚本。全部产物落在 `/tmp`，**绝不写真实 vault**。

| 文件 | 作用 |
|---|---|
| `make-corpus.sh` | 造 5 张不同形状/尺寸的合成 PNG（`/tmp/annex-gallery-b007/vault/20260417-plate-run`），并把该 vault `git init` 成仓库。 |
| `plate-profile.json` | 预设本体（`id=platewell`）：正则 `^plate(?<plate>\d+)(?:_well(?<well>[A-Z]\d+))?_(?<magnification>\d+)x_(?<index>\d+)$`，`frontmatter` 字典即输出顺序。 |
| `plate.md` | 上面这份预设的正文模板（`template` 指向 vault 里的 `AnnexGalleryTemplates/plate.md`）。 |
| `tecnaitem-profile.json` / `tecnaitem.md` | 另一条预设（`id=tecnaitem`，`<放大倍数>X-<标记>-<序号>`）：用来演示两条预设的 `match` 各自自动选择。 |
| `verify-frontmatter.cjs` | 逐份断言产出的 frontmatter：键序列 == `frontmatter` 字典顺序、number 裸值、date 裸日期、其余双引号、`notes` / 缺段 `well` 写 YAML null。 |
| `verify-plugin-load.cjs` | 用 `npm run smoke` 的桩环境加载 `main.js`，把两份示例预设登记进设置，证明插件读得回、正文模板随预设读入、外部改动即时生效、重复 id / 坏 JSON / 文件丢失都会让操作停下、旧内联 profiles 不迁移不参与运行时。 |

> **预设文件格式**：一份 `.json` = 一条预设，顶层就是 `ParseProfile` 对象（数组或
> `{ "profiles": [...] }` 都会被明确拒绝）。CLI 的 `--preset` 可以给多次，插件设置里也是
> 逐个登记这些 `.json`。预设里的 `template` 是 **vault 相对路径**，指向正文 `.md`。

一键复跑（在仓库根目录，需先 `npm run build`）：

```bash
export PATH="/Users/example/.hermes/tools/node-26.7.0-darwin-arm64/bin:$PATH"
npm run build
bash tools/example-profiles/make-corpus.sh
node tools/annex-gallery.mjs profiles --check --vault /tmp/annex-gallery-b007/vault \
  --preset tools/example-profiles/plate-profile.json
node tools/annex-gallery.mjs sidecar /tmp/annex-gallery-b007/vault/20260417-plate-run \
  --vault /tmp/annex-gallery-b007/vault --sample plate-demo \
  --preset tools/example-profiles/plate-profile.json --apply
node tools/example-profiles/verify-frontmatter.cjs
node tools/example-profiles/verify-plugin-load.cjs
```

`--preset` 的文件路径按**当前工作目录**解析；`plate-profile.json` 里的 `template` 按
`--vault` 解析，所以 `--check` 也要给 `--vault` 才能检查正文模板。

命名约定（5 张图）：`plate<板号>_well<孔位>_<放大倍数>x_<序号>.png`，其中 `plate02_4000x_012.png` **故意不带孔位段**，
用来演示「命名组未命中 ⇒ 键保留、值写 YAML null」。
