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
npm run cli -- sidecar <dir> --vault <vaultRoot> --sample <name> [--repo <root>] \
                        [--apply] [--overwrite] [--force] [--plan] [--json] [--template <id|file>]
npm run cli -- gallery <dir> --vault <vaultRoot> [--template <id|file>] [--profiles-file <json>] \
                        [--edge <n>] [--apply] [--overwrite] [--fix-tags] [--json]
npm run cli -- stems   <dir> [--json]
npm run cli -- drop    <dir> [--dry-run] [--force] [--json]
npm run cli -- annex   <add|unlock|lock|get|unannex|drop> <dir> [--json]
npm run cli -- profiles --list | --check | --parse <名字> [--path <相对路径>] [--profile <id>]
npm run cli -- defaults          # 打印插件内置的 .gitattributes 模板
```

（等价写法：`node tools/annex-gallery.mjs <子命令> …`。）

`--template` 认 **CLI 自带的预设 id**（metadata：`default` / `embed`；画廊：`default`）或模板文件路径；
不给 `--template` 时用 CLI 自带的 `default`（gallery 命令同理）。
**CLI 不读 `data.json`**，所以插件设置里登记的外部模板在 CLI 不可用 —— 自定义模板直接给文件路径。
这条是**刻意的例外**：插件运行时只认登记过的外部文件（没有内置兜底），命令行是脚本场景、没有设置页可点，
所以保留自带预设；两者的差别在 [`../setting-panel.md`](../setting-panel.md) §5 里写明。
`gallery` 默认 dry-run，`--fix-tags` / `--overwrite` 都必须与 `--apply` 同用。画廊与模板的完整口径见
[`../gallery.md`](../gallery.md)。

## 四条 CLI 约定

1. **破坏性动作都有 `--dry-run`。** 预览必须真的不写盘；`--force` 只在显式要求时出现，
   且只对「本来会被拒」的动作生效（例如丢弃唯一副本）。
2. **机器可读的输出用 `--json`。** 人读的输出可以变，`--json` 的字段是对判据的承诺。
3. **退出码表态。** 有失败就非零退出 —— 便于在脚本里串联多条判据。
4. **不假设 cwd。** 所有目录都由参数给出；路径的换算交给同一套 `src/core` 逻辑。

## 示例语料（`tools/example-profiles/`）

用来证明「一条完全不同的命名约定，只改配置就能跑通」：

| 文件 | 作用 |
|---|---|
| `make-corpus.sh` | 造几张不同形状/尺寸的合成 PNG，并把目录 `git init` 成仓库；产物只落在 `/tmp` |
| `plate-profile.json` | 多孔板成像的 profile（`plate01_wellA3_4000x_007` 这种形态），与 TECNAI 的约定完全不同 |
| `two-profiles.json` | 两条带 `match` 的 profile，用来演示按路径自动预选 |
| `verify-frontmatter.cjs` | 逐份断言产出的 frontmatter：键序 = `keyOrder`、number 是裸值、text 是双引号、缺段写空串 |
| `verify-plugin-load.cjs` | 用桩环境加载构建产物，把示例 profile 拆成**一份一个的外部 `.json`** 登记进设置，验证插件读得回、外部改动即时生效、重复 id / 坏 JSON / 文件丢失都会让操作失败、旧内联 profiles 不迁移不参与运行时 |

> **插件与 CLI 的 profile 格式不一样**：CLI 的 `--profiles-file` 吃**数组**（或 `{ "profiles": [...] }`），
> 因为它一次要读多条；插件设置里登记的是**一份一个对象**的 `.json`（顶层就是一条 `ParseProfile`），
> 数组格式在插件里会被明确拒绝。

**语料是合成的，绝不写真实 vault。** 这条不是洁癖：判据要能在任何机器上重跑，而且不能因为
「顺手拿真实数据试一下」而改动用户的数据仓库。
