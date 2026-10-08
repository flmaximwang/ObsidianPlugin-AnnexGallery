# ObsidianPlugin-AnnexGallery

把「侧车式图片库」做成 Obsidian 插件的仓库：在同一文件夹里为每张图产出 `<stem>.thumbnail.png`（缩略图）
与 `<stem>.md`（元数据 sidecar），再用 `.base` 的 cards 视图当图片浏览器；数据层仍是 **git + git-annex**。

本仓库同时收配套 skill [`obsidian-image-gallery`](skills/obsidian-image-gallery/SKILL.md) —— 它记录侧车模式
的字段形状、两个必踩的坑（annex 软链被 Obsidian 静默丢弃、链接必须写全 vault 路径）与交付前验证。

**可见性**：远端尚未创建，本仓库是唯一 source of truth（2026-10-08 起）。

## 插件规格（待实现 —— 用户 2026-10-08 口径）

| # | 入口 | 行为 |
|---|---|---|
| 1 | 注册命令 | **初始化 gallery**：将当前仓库初始化为 1 个用 git + git-annex 管理的 repo |
| 2 | 右键文件夹菜单 | **生成缩略图**：为该文件夹中所有的图片生成 `.thumbnail.png` 缩略图 |
| 3 | 右键文件夹菜单 | **使用 Annex Gallery 管理**：为该文件夹中的图片生成 `.md` 元数据，供 `.base` 查找 |
| 4 | 插件设置 | 可修改 `.gitattributes` 与 `.gitignore`（默认值见下） |

设置项的默认值：

- `.gitattributes` 默认指向 `.../lab_10_lab-project-a_2026.06.25/Data_lab_10/.gitattributes`
- `.gitignore` 默认只忽略 `.obsidian`

默认 `.gitattributes`（本机实况，逐字）：

```gitattributes
# 默认都进 annex
*               annex.largefiles=anything
# 缩略图不进 annex
*.thumbnail.png annex.largefiles=nothing
# .md 作为每个文件的 metadata, 进 git
*.md            annex.largefiles=nothing
# .base 作为文件展示的视图，进 git
*.base          annex.largefiles=nothing
```

## 索引

| skill | 用途 | 可执行入口 |
|---|---|---|
| [obsidian-image-gallery](skills/obsidian-image-gallery/SKILL.md) | 用 Bases 在 Obsidian 里做图片浏览器（缩略图 + sidecar md + cards 视图） | —（纯流程 / 方法论；命令在正文） |

装进 Hermes（三段式标识符，按仓库内路径，**不需要 tap**；`--category` 只决定落点）：

```bash
hermes skills install "flmaximwang/ObsidianPlugin-AnnexGallery/skills/obsidian-image-gallery" --category obsidian -y
```

安装时会 pin 到当时的 commit，之后 `hermes skills check` / `hermes skills update <name>` 直接可用。

**当前状态**：尚未发布（远端未创建）；`obsidian-image-gallery` 目前仍以手拷副本存在于 default 与
`plasmid-engineer` 两个 profile，**迁移完成后会走 hub 安装并清掉手拷副本**（需用户发话，见下）。

## skills/obsidian-image-gallery

一图三件套（`<stem>.tif` / `<stem>.thumbnail.png` / `<stem>.md`，同目录同 stem），`.base` 只读 sidecar 的
frontmatter，正文 `![[…thumbnail.png]]` 给 Obsidian 一个能渲染的 cover（`.tif` 它渲染不了）。

已实测的两个坑：

- **git-annex 工作树里的软链会被 Obsidian 静默丢弃**（`realpath` 落在 vault 根内即跳过）⇒ `[[…tif]]` 永远解析不到。
  首选解法 `annex.thin true` + `git annex unlock`（会改用户数据仓库语义，须先确认）。
- **缩略图必须按全 vault 路径链接**：显微图像 stem 跨会话重名（实测 118 个 basename 里 48 个被 >1 条笔记共用）。

交付前的五步验证（frontmatter 解析、双链目标存在、缩略图同一几何、`.base` 的 cards 视图带 `image: note.thumbnail`、
hub 笔记不带画廊 tag）都在 [SKILL.md](skills/obsidian-image-gallery/SKILL.md) 正文。
