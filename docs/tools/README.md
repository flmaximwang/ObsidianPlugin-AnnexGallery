# tools/ 设计原则

`tools/` 里放的不是「辅助脚本」，而是**这个插件的判据**：每一份工具都对应一条可以反复跑、
会真的判出「对 / 错」的检查。改完代码先跑判据，再谈「看起来对」。

## 四条总原则

1. **一个工具 = 一条判据。** 工具名、`package.json` 的 script 名、文档里的判据表三者一一对应；
   没有脚本兜着的结论不算结论。
2. **判据必须会红。** 每个工具都统计 `PASS / FAIL` 并以退出码表态（`FAIL > 0` ⇒ 非零退出），
   最后打印一个机器可读的成功标记（如 `SMOKE OK`）。只能打印、不会失败的检查不是判据。
3. **缺依赖要 SKIP，不要假 PASS。** 没装 `git annex` / `magick` / `websocket-client` 时，
   相关断言打印 SKIP 并以 0 退出 —— 「跳过」与「通过」在输出里必须能分开。
4. **工具不碰真实数据。** 临时目录、合成语料、只读查询；没有任何工具写用户的 vault 或仓库。

## 三层，从便宜到贵

| 层 | 依赖 | 能判什么 | 不能判什么 |
|---|---|---|---|
| 桩层（`stub-layer.md`） | Node + 构建产物 | 插件能否加载、菜单/设置页/DOM 结构、状态栏数值口径 | 真实 CSS 布局、原生控件尺寸、运行时行为 |
| 真仓库层（`real-repo-layer.md`） | 真 `git` + 真 `git annex` | init 幂等、annex 操作的报告与数据安全、规则文件合并 | UI、交互 |
| 真机层（`real-gui-layer.md`） | 跑着的 Obsidian + CDP | 视觉几何、配色、点击是否真触发、外部打开路径 | 批量回归（慢、要人准备环境） |

**升级路径是单向的**：桩层能覆盖的，绝不放进真机层；真机层只留「桩环境物理上量不出来」的项
（原生控件按最长选项定宽、外部应用的进程行为、人眼观感）。

## 各工具一览

| 工具 | 层 | npm script | 对应文档 |
|---|---|---|---|
| `tools/obsidian-stub.cjs` | 桩层（基础设施） | — | `stub-layer.md` |
| `tools/smoke-test.cjs` | 桩层 | `npm run smoke` | `context-menu.md`、`setting-panel.md` |
| `tools/layout-check.cjs` | 桩层 + headless Chromium | `npm run layout` | `setting-panel.md` |
| `tools/status-check.cjs` | 真仓库层 | `npm run verify:status` | `status-bar.md` |
| `tools/remotes-check.cjs` | 真仓库层 | `npm run remotes` | `setting-panel.md` |
| `tools/verify-init.cjs` | 真仓库层 | `npm run verify:init` | `commands.md` |
| `tools/verify-annex-ops.cjs` | 真仓库层 | `npm run verify:annex` | `context-menu.md` |
| `tools/verify-sidecar-overwrite.cjs` | 真仓库层 | `npm run verify:sidecar` | `metadata.md` |
| `tools/verify-gallery.cjs` | 真仓库层 | `npm run verify:gallery` | `gallery.md` |
| `tools/status-gui-check.py` | 真机层 | `npm run gui:status` | `status-bar.md` |
| `tools/real-gui-check.py` | 真机层 | `npm run gui` | `setting-panel.md` |
| `tools/cli.ts` → `tools/annex-gallery.mjs` | CLI | `npm run cli` | `cli.md` |
| `tools/example-profiles/` | 语料 | — | `cli.md` |
| `tools/example-profiles/verify-plugin-load.cjs` | 桩层（语料 + 插件加载） | — （手工跑） | `metadata.md` |

> 桩层判的是**外部文件模型**：文件名匹配模板、metadata 模板、画廊模板都以 vault 里的文件为准，
> 登记 / 从预设创建 / 打开 / 取消登记、坏文件在写盘前停下、旧内联配置不迁移 —— 都在 `npm run smoke`
> 与 `tools/example-profiles/verify-plugin-load.cjs` 里。

## 输出约定

- 每条断言一行，`✓` / `✗` 前缀 + 一句能读懂的话；`✗` 后面跟实测值与期望值的差异。
- 结尾一行汇总 `PASS=<n> FAIL=<n>`，成功时再跟一个全大写的成功标记。
- 不打印时间戳、不打印本机路径 —— 判据要在任何机器上读完都能判断。
