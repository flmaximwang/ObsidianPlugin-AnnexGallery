# CLI 与示例语料

## 为什么有 CLI

插件与 CLI 共用同一套核心逻辑（`src/core/*` 不 import `obsidian`）：插件负责 UI 与交互，
CLI 负责**可脚本化的同一批动作**。这样「插件里点出来的结果」和「命令行跑出来的结果」可以用同一条
判据对照，也让批量处理不必打开 Obsidian。

源码是 `tools/cli.ts`，`npm run build` 顺带把它打成 `tools/annex-gallery.mjs`
（构建产物，**不入库**，和 `main.js` 一样）。

## 命令面

```bash
npm run cli -- init    <dir> [--dry-run] [--json]
npm run cli -- thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
npm run cli -- sidecar <dir> --vault <vaultRoot> --sample <name> [--repo <root>] \
                        [--apply] [--overwrite] [--force] [--plan] [--json]
npm run cli -- stems   <dir> [--json]
npm run cli -- drop    <dir> [--dry-run] [--force] [--json]
npm run cli -- annex   <add|unlock|lock|get|unannex|drop> <dir> [--json]
npm run cli -- profiles --list | --check | --parse <名字> [--path <相对路径>] [--profile <id>]
npm run cli -- defaults          # 打印插件内置的 .gitattributes 模板
```

（等价写法：`node tools/annex-gallery.mjs <子命令> …`。）

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
| `plate-profile.json` | 多孔板成像的 profile（`plate01_wellA3_4000x_007` 这种形态），与内置 TECNAI 的约定完全不同 |
| `two-profiles.json` | 两条带 `match` 的 profile，用来演示按路径自动预选 |
| `verify-frontmatter.cjs` | 逐份断言产出的 frontmatter：键序 = `keyOrder`、number 是裸值、text 是双引号、缺段写空串 |
| `verify-plugin-load.cjs` | 用桩环境加载构建产物，把多孔板 profile 塞进 `data.json` 的 `profiles`，证明插件读得回、内置的那条没丢 |

**语料是合成的，绝不写真实 vault。** 这条不是洁癖：判据要能在任何机器上重跑，而且不能因为
「顺手拿真实数据试一下」而改动用户的数据仓库。
