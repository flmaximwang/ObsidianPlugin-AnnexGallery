# CLI 与示例语料

## 为什么有 CLI

插件与 CLI 共用同一套核心逻辑（`src/core/*` 不 import `obsidian`）：插件负责 UI 与交互，
CLI 负责**可脚本化的同一批动作**。这样「插件里点出来的结果」和「命令行跑出来的结果」可以用同一条
判据对照，也让批量处理不必打开 Obsidian。

源码是 `scripts/cli.ts`（社区目录扫描忽略 `scripts/`，CLI 的 console 输出因此不会触发审核告警），
`npm run build` 顺带把它打成 `tools/annex-gallery.mjs`（构建产物，**不入库**，和 `main.js` 一样）。

## 命令面

```bash
npm run cli -- init    <dir> [--dry-run] [--json]
npm run cli -- thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
npm run cli -- sidecar <dir> --vault <vaultRoot> --preset <json> [--preset <json> ...] \
                        [--profile <id>] [--sample <name>] [--ask key=value] [--repo <root>] \
                        [--apply] [--force] [--overwrite] [--plan] [--verify] [--json]
npm run cli -- gallery <dir> --vault <vaultRoot> --preset <json> [--preset <json> ...] \
                        [--template <file>] [--edge 256] [--apply] [--overwrite] [--fix-tags] [--json]
npm run cli -- profiles --list | --check | --parse <name> --preset <json> [--preset <json> ...] \
                        [--vault <root>] [--path <相对路径>] [--profile <id>] [--json]
npm run cli -- stems   <dir> [--json]
npm run cli -- drop    <dir> [--dry-run] [--force] [--json]
npm run cli -- annex   <add|unlock|lock|get|unannex|drop> <dir> [--json]
npm run cli -- defaults          # 打印插件内置的 .gitattributes 模板
```

（等价写法：`node tools/annex-gallery.mjs <子命令> …`。）

## 元数据预设：只有 `--preset <file>` 一种入口

**CLI 没有任何内置预设。** 一条预设 = 一个 `.json` 文件，**顶层就是一条 `ParseProfile` 对象**
（文件放在哪儿都行 —— CLI 按当前工作目录找它）：

```bash
node tools/annex-gallery.mjs sidecar ./run --vault /path/to/vault \
  --preset ./presets/tecnaitem.json --preset ./presets/platewell.json
```

- `--preset` **可以给多次**：一次给几条，就按给的顺序加载、按给的顺序排 `{{properties}}` 的键序。
- **不给 `--preset` 直接报错**，没有内置兜底、也没有「第一条已登记」这种隐式来源（CLI 不读
  `data.json`，没有设置页可点）。
- **预设文件路径按当前工作目录解析**（`path.resolve`）；**预设里的 `template`（正文 `.md`）按 `--vault`
  解析** —— 它是 vault 相对路径，由 core 的 `readVaultTextFile(..., "metadata")` 读。
- 旧格式预设（顶层带 `keyOrder` / `fields` / `constFields` / `pathFields` / `whenMissing` /
  `metadataTemplate`）与 `{ "profiles": [...] }` 包装格式**都不再接受**，加载时直接报错。
- `--profile <id>` 从已给的预设里挑一条：`sidecar` 用它决定用哪条（不给就按预设的 `match` 自动选，
  再不行用第一条）；`profiles --parse` 用它指定解析哪条。

`sidecar` **不再接受 `--template`** —— sidecar 的正文由预设自己的 `template` 字段决定，
换预设就换正文。`gallery` 的 `--template <file>` 是**画廊 `.base` 模板的文件路径**（不是 id）。

## 各子命令

| 子命令 | 做什么 | 关键点 |
|---|---|---|
| `sidecar <dir>` | 为目录内所有图片生成 `<stem>.md` | 默认 dry-run，`--apply` 才写。`--overwrite` 覆盖重算已存在的 sidecar；`--plan` 只读盘点；`--verify` 逐字节比对、绝不写盘（diff / missing 都会让退出码非零）。`--ask key=value` 给 ask 变量（可给多次），`--sample <name>` 是 `sample` 的便捷写法。`--repo <root>` 指 git 仓库根（脏文件保护用）。 |
| `gallery <dir>` | 盘点目录并生成 `<文件夹>/<文件夹名>.base` | 默认 dry-run。`--fix-tags` 给旧 sidecar 补 `annex-gallery-metadata` 标签（必须与 `--apply` 同用）。`--template <file>` 给 `.base` 模板路径；不给时用 CLI 自带的画廊预设 `default`（插件运行时没有这个兜底）。 |
| `profiles --list` | 列出每条预设的 id / name / source / frontmatter 键 / 正文路径 | 一行一条；读不出来的预设也会列出来并写明原因。 |
| `profiles --check` | 对全部预设跑校验 | 有 error 级问题就退 1；warn 只打印。正文模板的检查需要 `--vault`。 |
| `profiles --parse <名字>` | 打印解析出的组值、缺失的组与算出来的 frontmatter | `--path <相对路径>` 给出 vault 相对路径（用来命中 `match.relpathRegex`；不给时 `<名字>` 本身当文件名与相对路径）。`--vault` + `--path` 能定位到真实图片时宽高 / 大小是真值，否则用占位值（输出里会写明）。 |

## 四条 CLI 约定

1. **破坏性动作都有 `--dry-run`。** 预览必须真的不写盘；`--force` 只在显式要求时出现，
   且只对「本来会被拒」的动作生效（例如丢弃唯一副本）。
2. **机器可读的输出用 `--json`。** 人读的输出可以变，`--json` 的字段是对判据的承诺。
3. **退出码表态。** 有失败就非零退出 —— 便于在脚本里串联多条判据。
4. **不假设 cwd。** 所有目录都由参数给出；路径的换算交给同一套 `src/core` 逻辑
   （唯一例外是 `--preset` 的文件路径：它按当前工作目录解析，因为那是脚本作者手里的文件）。

## 示例语料（`tools/example-profiles/`）

用来证明「一条完全不同的命名约定，只改配置就能跑通」。语料里的预设与插件用的是**同一种文件**：
**一条预设一个 `.json`**，顶层是一条 `ParseProfile`（不是数组、不是 `{ "profiles": [...] }`）。

| 文件 | 作用 |
|---|---|
| `make-corpus.sh` | 造几张不同形状/尺寸的合成 PNG，并把目录 `git init` 成仓库；产物只落在 `/tmp` |
| `plate-profile.json` | 多孔板成像的元数据预设（`plate01_wellA3_4000x_007` 这种形态），与 TECNAI 的约定完全不同 |
| 两条带 `match` 的预设 | 演示按路径 / 文件名自动预选；新格式下一条一个 `.json`，所以是两份文件 |
| `verify-frontmatter.cjs` | 逐份断言产出的 frontmatter：键序 = 预设字典的书写顺序、number 是裸值、text 是双引号、缺值写 YAML null |
| `verify-plugin-load.cjs` | 用桩环境加载构建产物，把示例预设拆成**一份一个的外部 `.json`** 登记进设置，验证插件读得回、外部改动即时生效、重复 id / 坏 JSON / 文件丢失都会让操作失败、旧内联 profiles 不迁移不参与运行时 |

> **插件与 CLI 用的是同一种文件**：一条预设 = 一个 `.json`（顶层是一条 `ParseProfile`）。
> 差别只在于**怎么找到它**：插件在设置页登记 vault 相对路径，CLI 用 `--preset <file>` 给文件路径。
> 旧的 `--profiles-file`（数组 / `{ "profiles": [...] }`）已经没有了。

**语料是合成的，绝不写真实 vault。** 这条不是洁癖：判据要能在任何机器上重跑，而且不能因为
「顺手拿真实数据试一下」而改动用户的数据仓库。
