---
name: obsidian-image-gallery
description: Use when building an Obsidian gallery over images.
platforms: [macos, linux, windows]
---

# Image gallery in Obsidian via Bases (sidecar-md pattern)

Use when the user wants an image *browser* in Obsidian (gallery, contact sheet, filterable image
library) over a data folder — typically replacing Eagle / TagSpaces. Verified against Obsidian
1.14.4 and a 218-image TEM library (`lab_10/Data/TEM`, git-annex).

## The shape that works

One image = three files, same folder, same stem:

```
<folder>/<stem>.tif              # original (may be an annex symlink — see pitfall 1)
<folder>/<stem>.thumbnail.png    # 256x256 cover by default (plugin setting; keep == .base cardSize)
<folder>/<stem>.md               # the metadata file ("the Eagle .info replacement")
```

- Thumbnail name MUST be `<stem>.thumbnail.png`, not `<stem>.png`: a later original may itself be a
  `.png`, and derived artifacts must stay distinguishable from source images.
- Sidecar frontmatter carries every displayable/filterable value; the `.base` only reads them.
- Body: two *clickable links*, not image embeds — `缩略图：[[<full vault path>.thumbnail.png]]`
  then `原图（用系统默认程序打开）：[[<full vault path>.tif]]`. Do **not** write `![[…]]` embeds
  (user directive, 2026-10-08): Obsidian cannot render `.tif` anyway, and the cards-view cover comes
  from the frontmatter `image: note.thumbnail` key, not from a body embed.
- ImageMagick one-liner (macOS has `magick`; no PIL needed):
  `magick in.tif -resize 256x256 -strip -define png:compression-level=9 out.thumbnail.png`
  An sRGB 2048x2048 tif lands as an 8-bit Grayscale png — measured ~49 KB at 256x256 (~7 KB at 96x96).
  Thumbnails stay in git (`.gitattributes` → `annex.largefiles=nothing`), so 218 of them ≈ 10 MB.

## Pitfall 1 — symlinked sources (git-annex, DVC, DataLad) are silently DROPPED

Obsidian's FileSystemAdapter walks the vault, `lstat()`s each entry, and for a symlink resolves
`realpath` then **skips it when the target is inside the vault root** ("Symlink targets must be
fully disjoint from the vault root", obsidian.md/help/symlinks). Source, `obsidian.asar`:
`reconcileFileInternal` -> `reconcileSymbolicLinkCreation` ->
`for (a in watchers) if (i.startsWith(w.resolvedPath + sep)) return;`

Consequence: a git-annex working tree inside the vault always loses — its symlinks point at
`<repo>/.git/annex/objects/...`, which is inside the vault. The `.tif` never enters the index and
`[[path.tif]]` stays an unresolved link, whatever link format you use. Folder symlinks are
rejected outright; file symlinks are "may work" only when the target is outside the vault.

Fixes, in order of preference:
1. **Unlock with thin** — `git config annex.thin true` then `git annex unlock <paths>`: the working
   tree becomes real files hardlinked to the annex objects (same filesystem), so Obsidian indexes
   them as ordinary attachments at zero extra disk cost. Cost: with `annex.thin` you must never edit
   those files in place, and `git annex drop` semantics change. Confirm with the user first — it
   mutates their data repo.
2. Keep symlinks and make the vault root not contain `.git` (vault = the image folder, repo above
   it). Layout-fragile; only when the user won't unlock.

Same trap applies to your own sidecars: if the repo sets `annex.largefiles=include=*`, a later
`git annex add` turns `.md`/`.thumbnail.png` into symlinks too and the gallery silently dies.
Pin them with `.gitattributes`: `*.md annex.largefiles=nothing` / `*.thumbnail.png annex.largefiles=nothing`.

## Pitfall 2 — link the thumbnail by FULL vault path

Microscopy stems repeat across sessions (`12345X-1-0001.tif` in two different date folders): in one
218-image library 48 of 118 basenames were shared by >1 note. Basename-only wikilinks then resolve
to the wrong file. Write `thumbnail: "[[Data/TEM/<session>/<stem>.thumbnail.png]]"` (same for `tif`).
Assert it in the build: count duplicate basenames before choosing the link format.

## Cards view keys (read out of the 1.14.4 settings schema, not guessed)

```yaml
views:
  - type: cards
    name: 画廊·全部
    image: note.thumbnail        # key is `image`, type property, value must be a wikilink
    imageAspectRatio: 1          # slider .25-2.5, step .05, default 1
    imageFit: contain            # {"": cover, contain}
    cardSize: 96                 # slider 50-800, step 10, default 200 — width of a card
    order: [file.name, sample]   # properties printed on the card
    groupBy: {property: note.session, direction: ASC}
```

Set `cardSize` equal to the thumbnail's pixel size, otherwise the cover is upscaled and looks soft.
At 96 px a cover is enough to tell images apart but useless for judging structure — say so when the
user asks for 96 px, and keep the thumbnail size a single constant so re-rendering at 500 px (with
cardSize 500) is one command.

## Frontmatter fields that earn their place

`tags: [<gallery tag>]` (the base filter), plus per-image: source id, sample/group, session/folder,
date, magnification, lens, index, width, height, size, and the two link fields. Keep numeric fields
unquoted and camelCase. Mirroring an existing library's own field names (Eagle: `btime`, `eagleId`,
`size`) is the cheapest way to make the sidecars credible — but **verify what a timestamp means
before naming it**: Eagle `btime` looked like acquisition time, yet within one session the 10-30
images spanned 0.1-2 min in index order and sibling session folders interleaved — that is file-write
/ import time, not exposure time. Name it `btime`, don't name it `acquired`.

## Config-driven metadata parsing（配置驱动的 metadata 解析）

The generator ships a TECNAI profile but is **not** TECNAI-only: a *profile* is one regex with named
groups → named/typed fields → the exact frontmatter key order. The schema of record is the types plus
`DEFAULT_PROFILES` in `src/core/profiles.ts` (`ParseProfile`, `FieldSpec`, `DERIVED_KEYS`,
`COMPUTED_KEYS`, `DEFAULT_ASK`). Adding a second, unrelated naming convention means editing
settings/JSON only — no code change. The settings tab edits multiple profiles (persisted in
`data.json`'s `profiles` array); the right-click prompt pre-selects by `match` and remembers the
choice per folder.

Five value sources per profile, precedence `parsed/pathFields > constFields > ask > derived > computed`:

1. **parsed** — `regex` named groups → `fields` (`type: "number"` renders bare, default `text` renders double-quoted);
2. **derived** — `tags` (first vault-relative path segment), `session` (folder name), `date` (first 8 chars of `session` → `YYYY-MM-DD`, else empty);
3. **computed** — `width`/`height` (`magick identify`), `size` (bytes), `btime` (file birthtime, *not* exposure), `thumbnail`/`tif` (both `"[[full vault path]]"`);
4. **constant** — `constFields`;
5. **asked** — `ask` (default `["sample"]`), filled in the right-click prompt, remembered per folder.

`keyOrder` **is** the final frontmatter key order: keys not listed are never written (add a field only
if you also add it to `keyOrder`); a listed key with no value from any source is **omitted** and noted
in that sidecar's detail. Three hard rules: (1) named groups absent from `fields` are **discarded** —
this lets you write branch regexes such as `(?:(?<lens>\d{1,2})|(?<lensToken>[0-9A-Za-z]+))` where the
long token only balances the alternation; (2) a group that did not participate in the match writes its
field's `whenMissing` (default empty string, key kept); (3) a fully non-matching name follows
`onMismatch` — `empty` (blank fields, counted in `mismatch`, default) or `skip`. `pathRegex` +
`pathFields` run on the vault-relative path and override same-named derived values.

CLI surface: `node tools/annex-gallery.mjs profiles --list | --check | --parse "<name>" [--path <rel>]
[--profile <id>]`, and `sidecar <dir> --vault <root> --profiles-file <json> [--profile <id>]
[--apply|--verify]`. A worked example with a `plate/well/magnification/index` convention completely
unlike TECNAI — plus a rerun script — lives in `tools/example-profiles/`.

## A live Obsidian session rewrites your .base

While the vault is open, the app re-serializes `.base` files after any UI edit: keys get reordered,
`note.session` in `groupBy`/`summaries` is normalized to `session`, and user tweaks (an extra card
property, a dragged `cardSize` slider) land in the same file. Consequences: (1) a blind
regex/rewrite of the `.base` can silently clobber or miss what the user set by hand — read the
current file first and patch exact values; (2) a count-based sed-style replacement gives false
confidence ("5 replacements" when one card had been pulled to a different number). Re-read and
assert the final value per view.

## Validation before reporting done

1. `yaml.safe_load` every sidecar's frontmatter; assert required keys and types (`datetime` is a
   legitimate parse of an unquoted timestamp — don't fail it), tag present.
2. For each link field, regex `\[\[(.+)\]\]` and assert the target exists under the vault root.
3. `magick identify -format "%w %h\n"` every thumbnail; assert one geometry bucket.
4. `yaml.safe_load` the `.base`; assert the cards views carry `image: note.thumbnail`.
5. The hub/index note must NOT carry the gallery tag, or it renders as a row. Assert that.
