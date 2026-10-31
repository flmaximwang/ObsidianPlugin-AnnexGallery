#!/usr/bin/env python3
"""真机（跑着的 Obsidian）复核 Annex Gallery 设置页 —— 离屏量不出来的那几项。

    # 先带调试端口重启 Obsidian（端口只在启动时生效），例如 9333：
    osascript -e 'quit app "Obsidian"'
    open -na /Applications/Obsidian.app --args --remote-debugging-port=9333 "--remote-allow-origins=*"
    python3 tools/real-gui-check.py [vault 名（默认 Data_lab_10）]

为什么需要它（离屏 tools/layout-check.cjs 覆盖不到）：
  * 原生 `<select>` 的宽度由**最长选项文字**决定 —— 桩环境里 option 没有真实字体度量，
    真机里 profile 预设名很长；只有真机能确认外置工具条没被撑破。
  * 真实插件 settings 与设置页 DOM 的对应关系（登记了几份外部文件就渲染几行）只有真机可核。
  * 观察观感（配色、空旷感）最终要人眼看截图；本脚本负责把截图生成出来 + 把结构判据钉死。

本脚本**不会点「打开」**（那会拉起系统默认应用），Open 成功/失败宿主行为由
tools/smoke-test.cjs 用可替换的 openWithDefaultApp 覆盖。

结构（探过的实况，别猜）：Obsidian 1.14 里 `app.setting.open()` 会把设置开成**独立窗口**
（target 标题「设置 - <vault>」，url=about:blank，body 带 is-popout-window/is-popout-modal）；
那个窗口里**没有** `app` 全局：
  * 读 DOM / 点按钮        → 设置窗口那个 target
  * 读 app / 插件 settings → 主窗口（app://obsidian.md/index.html）那个 target
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

try:
    import websocket
except ImportError:  # pragma: no cover
    sys.exit("缺依赖：pip install websocket-client")

PORT = int(os.environ.get("ANNEX_CDP_PORT", "9333"))
SHOT = os.environ.get("ANNEX_SHOT", "/tmp/annex-settings-real.png")

pass_count = 0
fail_count = 0


def check(ok, message, detail=""):
    global pass_count, fail_count
    if ok:
        pass_count += 1
        print(f"  ✓ {message}")
    else:
        fail_count += 1
        print(f"  ✗ {message}  —— {detail}")


def targets():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        return json.load(r)


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, max_size=512 * 1024 * 1024)
        self._id = 0

    def call(self, method, **params):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def js(self, expr, raw=False):
        res = self.call("Runtime.evaluate", expression=expr, returnByValue=True)
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            return {"__error__": f"{d.get('text')} {res.get('result', {}).get('description', '')}"[:240]}
        value = res.get("result", {}).get("value")
        if raw:
            return value
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value


def pick(title_part, url_part=None):
    for t in targets():
        if title_part in (t.get("title") or "") and (url_part is None or url_part in (t.get("url") or "")):
            return t
    return None


PROBE = r"""JSON.stringify((() => {
  const pane = document.querySelector('.vertical-tab-content');
  if (!pane) return {error: 'no settings pane in this target'};
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return {left:+b.left.toFixed(1), top:+b.top.toFixed(1), right:+b.right.toFixed(1), width:+b.width.toFixed(1), height:+b.height.toFixed(1)}; };
  const cs = (el, p) => el ? getComputedStyle(el)[p] : null;
  const text = (el) => el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) : null;
  const bar = pane.querySelector('.annex-profiles-toolbar');
  const remotes = pane.querySelector('.annex-remotes-card');
  const h1 = pane.querySelector('.annex-settings-title');
  const groups = [...pane.children].filter(c => c.classList.contains('setting-group'));
  const profileRows = [...pane.querySelectorAll('.annex-profile-row')];
  const templateCards = [...pane.querySelectorAll('.annex-templates-card')];
  return {
    contentLeft: +((pane.getBoundingClientRect().left) + parseFloat(cs(pane,'paddingLeft'))).toFixed(1),
    contentRight: +((pane.getBoundingClientRect().right) - parseFloat(cs(pane,'paddingRight'))).toFixed(1),
    topLevel: [...pane.children].map(c => c.tagName + '.' + c.className),
    h1: h1 ? {text: h1.textContent.trim(), display: cs(h1,'display'), left: box(h1).left, padL: cs(h1,'paddingLeft'), height: box(h1).height} : null,
    h1Count: pane.querySelectorAll('.annex-settings-title').length,
    hrCount: pane.querySelectorAll('hr').length,
    groups: groups.map(g => ({
      cls: g.className,
      heading: text(g.querySelector(':scope > .setting-item-heading > .setting-item-name')),
      items: [...g.querySelectorAll(':scope > .setting-items > .setting-item')].map(s => text(s.querySelector(':scope > .setting-item-info > .setting-item-name'))),
      renderRows: [...g.querySelectorAll(':scope > .setting-items > .setting-item')].filter(s => s.classList.contains('annex-editor-row')).length,
      box: box(g),
    })),
    toolbar: bar ? {justify: cs(bar,'justifyContent'), wrap: cs(bar,'flexWrap'), box: box(bar),
      controls: [...bar.children].filter(c => cs(c,'display') !== 'none').map(c => ({
        tag: c.tagName,
        label: c.tagName === 'SELECT' ? (c.options[0] ? c.options[0].text : '') : c.textContent.trim(),
        placeholder: c.getAttribute('placeholder'),
        box: box(c),
      }))} : null,
    profileRows: profileRows.map(r => ({
      box: box(r),
      state: r.getAttribute('data-state'),
      name: text(r.querySelector('.annex-profile-name')),
      id: text(r.querySelector('.annex-profile-id')),
      path: text(r.querySelector('.annex-profile-path')),
      open: box(r.querySelector('.annex-profile-open')),
      del: box(r.querySelector('.annex-profile-del')),
      error: r.querySelector('.annex-profile-error') ? text(r.querySelector('.annex-profile-error')) : null,
    })),
    oldUi: {
      cards: pane.querySelectorAll('.annex-profile-card').length,
      actions: pane.querySelectorAll('.annex-profile-actions').length,
      preview: pane.querySelectorAll('.annex-preview-filename').length + pane.querySelectorAll('.annex-preview-result').length,
      json: pane.querySelectorAll('.annex-profile-json').length,
      status: pane.querySelectorAll('.annex-profile-status').length,
      builtinRows: pane.querySelectorAll('.annex-template-builtin').length,
      viewButtons: pane.querySelectorAll('.annex-template-view-btn').length,
      copyButtons: pane.querySelectorAll('.annex-template-copy').length,
    },
    templateCards: templateCards.map(card => ({
      kind: card.getAttribute('data-kind'),
      box: box(card),
      title: text(card.querySelector('.annex-templates-title')),
      empty: card.querySelector('.annex-templates-empty') !== null,
      rows: [...card.querySelectorAll('.annex-template-row')].map(r => ({
        state: r.getAttribute('data-state'),
        id: text(r.querySelector('.annex-template-id')),
        path: text(r.querySelector('.annex-template-path')),
        error: r.querySelector('.annex-template-error') ? text(r.querySelector('.annex-template-error')) : null,
      })),
      add: (() => {
        const add = card.querySelector('.annex-template-add-row');
        if (!add) return null;
        return {
          input: box(add.querySelector('.annex-template-path-input')),
          button: box(add.querySelector('.annex-template-add')),
          select: box(add.querySelector('.annex-template-preset')),
          buttonText: text(add.querySelector('.annex-template-add')),
          selectFirst: add.querySelector('.annex-template-preset') ? add.querySelector('.annex-template-preset').options[0].text : null,
        };
      })(),
    })),
    legacyWarning: pane.querySelector('.annex-legacy-profiles-warning') ? text(pane.querySelector('.annex-legacy-profiles-warning')) : null,
    remoteRows: remotes ? [...remotes.querySelectorAll('.annex-remote-row')].map(r => ({name: r.querySelector('.annex-remote-name').value, url: r.querySelector('.annex-remote-url').value, box: box(r)})) : null,
    remoteAdd: remotes ? remotes.querySelector('.annex-remote-add').textContent.trim() : null,
    plainSettings: [...pane.querySelectorAll('.setting-item')].map(s => s.getAttribute('data-name') || (s.querySelector('.setting-item-name') ? s.querySelector('.setting-item-name').textContent.trim() : null)),
  };
})())"""


def main():
    wanted = sys.argv[1] if len(sys.argv) > 1 else "Data_lab_10"
    main_t = pick(wanted, "app://obsidian.md")
    if main_t is None:
        print(json.dumps({"error": f"找不到 {wanted} 主窗口（Obsidian 是不是没带 --remote-debugging-port={PORT} 启动？）",
                          "targets": [t.get("title") for t in targets()]}, ensure_ascii=False))
        return 1
    app = CDP(main_t["webSocketDebuggerUrl"])
    app.call("Runtime.enable")

    env = app.js(r"""JSON.stringify((() => {
      const p = app.plugins.plugins['annex-gallery'];
      return {
        vault: app.vault.getName(),
        vaultPath: app.vault.adapter.getBasePath(),
        loaded: Boolean(p),
        version: p ? p.manifest.version : null,
        settingsKeys: p ? Object.keys(p.settings) : null,
        remotes: p ? p.settings.remotes : null,
        profileFiles: p ? p.settings.profileFiles : null,
        metadataTemplates: p ? p.settings.metadataTemplates : null,
        baseTemplates: p ? p.settings.baseTemplates : null,
        legacyPresent: p ? Boolean(p.legacyInlineProfiles && p.legacyInlineProfiles.present) : null,
        legacyCount: p && p.legacyInlineProfiles ? p.legacyInlineProfiles.count : null,
      };
    })())""")
    print(f"主窗口：{main_t['title']}\nvault：{env.get('vaultPath')}  插件 loaded={env.get('loaded')} version={env.get('version')}")
    print(f"settings 键：{env.get('settingsKeys')}")

    # 先从盘上重载插件：styles.css 是插件加载时才注入 <style> 的，
    # 不重载就会量到内存里的旧 CSS（部署了却看不出变化，最容易自欺）。
    reloaded = app.js("(() => { const id = 'annex-gallery'; app.plugins.disablePlugin(id); app.plugins.enablePlugin(id); return JSON.stringify({loaded: Boolean(app.plugins.plugins[id])}); })()")
    print(f"插件已从盘上重载（styles.css 重新注入）：{reloaded}")
    time.sleep(1.5)

    app.js("(() => { app.setting.open(); app.setting.openTabById('annex-gallery'); return '\"ok\"'; })()")
    time.sleep(2.5)
    set_t = pick("设置")
    if set_t is None:
        print("✗ 没有出现设置窗口")
        return 1
    ui = CDP(set_t["webSocketDebuggerUrl"])
    ui.call("Runtime.enable")
    ui.call("Page.enable")
    time.sleep(0.8)
    rep = ui.js(PROBE)
    if rep.get("error"):
        print(f"✗ {rep['error']}")
        return 1

    print("\n真机结构判据（声明式设置页 · 外部文件模型）：")
    check(rep["h1Count"] == 0, f"设置页没有旧的 h1 标题：{rep['h1Count']} 个")
    check(rep["hrCount"] == 0, f"设置页没有 hr 分割线（改用 group heading）：{rep['hrCount']} 条")
    groups = rep["groups"]
    check(len(groups) == 3, f"顶层 = 3 个 .setting-group：{[g['cls'] for g in groups]}")
    if len(groups) == 3:
        headings = [g["heading"] for g in groups]
        check(headings == [None, "文件名匹配模板与模板", "常规"],
              f"三个 group 的 heading = 无 → 文件名匹配模板与模板 → 常规：{headings}")
        item_names = [g["items"] for g in groups]
        check(item_names == [["remote 设置"], ["文件名匹配模板", "metadata 与画廊模板"], ["缩略图边长", "调试日志"]],
              f"每个 group 的设置项：{item_names}")
        render_rows = [g["renderRows"] for g in groups]
        check(render_rows == [1, 2, 0],
              f"render 项（三个编辑器）只出现在前两个 group：{render_rows}")
        check(rep["remotes"] is not None and abs(rep["remotes"]["card"]["left"] - groups[0]["box"]["left"]) < 1.5,
              f"remote 卡片与第一个 group 左对齐：{rep['remotes']['card']['left'] if rep['remotes'] else '?'} vs {groups[0]['box']['left']}")
    got = [c.split(".", 1)[1].split(" ")[0] for c in rep["topLevel"]]
    check(all(c == "setting-group" for c in got),
          f"顶层全部是 .setting-group（没有散的 h1 / hr / setting-item）：{rep['topLevel']}")

    # ── 文件名匹配模板：路径输入 + 登记 + 从预设创建（只有外部文件） ──────────
    bar = rep["toolbar"] or {}
    controls = bar.get("controls", [])
    labels = [c["label"] for c in controls]
    check(len(controls) == 3, f"工具条只有 3 个控件：{labels}")
    check(controls and controls[0]["tag"] == "INPUT" and "profile JSON 路径" in (controls[0].get("placeholder") or ""),
          f"第 1 格是 vault 相对路径输入框：{controls[0] if controls else None}")
    check(len(controls) > 1 and controls[1]["tag"] == "BUTTON" and controls[1]["label"] == "登记",
          f"第 2 格是「登记」按钮：{controls[1] if len(controls) > 1 else None}")
    check(len(controls) > 2 and controls[2]["tag"] == "SELECT" and controls[2]["label"] == "从预设创建…",
          f"第 3 格是「从预设创建…」下拉：{controls[2] if len(controls) > 2 else None}")
    if len(controls) == 3:
        check(controls[0]["box"]["left"] < controls[1]["box"]["left"] < controls[2]["box"]["left"],
              "三个控件真的从左往右排")
        centers = [c["box"]["top"] + c["box"]["height"] / 2 for c in controls]
        check(max(centers) - min(centers) < 2, f"三个控件在同一行（原生 select 宽度没有把工具条挤断）：{centers}")
        check(controls[2]["box"]["width"] < 360,
              f"「从预设创建…」下拉宽度受 CSS max-width 约束：{controls[2]['box']['width']}px")
        check(abs(controls[2]["box"]["right"] - bar["box"]["right"]) < 2,
              f"预设下拉贴住工具条右边缘：{controls[2]['box']['right']} vs {bar['box']['right']}")

    profiles = rep["profileRows"]
    wanted_paths = [entry.get("path") for entry in (env.get("profileFiles") or [])]
    shown_paths = [row["path"] for row in profiles]
    check(len(profiles) == len(wanted_paths),
          f"设置里登记了 {len(wanted_paths)} 份外部 profile，设置页就渲染 {len(profiles)} 行：{shown_paths}")
    check(shown_paths == wanted_paths,
          f"每行 path 与 data.json 的 profileFiles 一一对应：设置={wanted_paths} 页面={shown_paths}")
    check(all(row["id"] and row["id"].startswith("id: ") for row in profiles),
          f"每行都显示外部 JSON 的 id：{[row['id'] for row in profiles]}")
    check(all(row["open"] and row["del"] for row in profiles), "每行都有「打开」「删除」")
    check(all(row["del"]["right"] <= row["box"]["right"] + 1 for row in profiles),
          "行内按钮没有溢出本行")

    old = rep["oldUi"]
    check(old["cards"] == 0 and old["actions"] == 0 and old["preview"] == 0 and old["json"] == 0 and old["status"] == 0,
          f"没有旧内联编辑器 / 预览 / 动作排：{old}")
    check(old["builtinRows"] == 0 and old["viewButtons"] == 0 and old["copyButtons"] == 0,
          f"没有可直接使用的内置模板行 / 查看 / 复制为自定义：{old}")

    # ── metadata / 画廊模板：一行一个已登记外部文件 ──────────────────────────
    cards = rep["templateCards"]
    check([c["kind"] for c in cards] == ["metadata", "base"],
          f"模板区 = metadata + 画廊模板两张卡片：{[c['kind'] for c in cards]}")
    for card, key in (("metadata", "metadataTemplates"), ("base", "baseTemplates")):
        found = next((c for c in cards if c["kind"] == card), None)
        if found is None:
            check(False, f"缺少 {card} 模板卡片")
            continue
        wanted_ids = [entry.get("id") for entry in (env.get(key) or [])]
        shown_ids = [row["id"].replace("id: ", "") if row["id"] else None for row in found["rows"]]
        check(len(found["rows"]) == len(wanted_ids),
              f"{card}：data.json 登记 {len(wanted_ids)} 份外部文件，页面渲染 {len(found['rows'])} 行：{shown_ids}")
        check(shown_ids == wanted_ids,
              f"{card}：页面每行 id 与登记项一一对应：设置={wanted_ids} 页面={shown_ids}")
        check(found["add"] is not None and found["add"]["buttonText"] == "登记" and found["add"]["selectFirst"] == "从预设创建…",
              f"{card}：登记行 = 路径输入 + 登记 + 从预设创建…：{found['add']}")
        check(len(found["rows"]) > 0 or found["empty"],
              f"{card}：没有登记项时显示引导（而不是内置模板）：{found['empty']}")

    legacy_present = env.get("legacyPresent")
    check((rep["legacyWarning"] is not None) == bool(legacy_present),
          f"旧内联 profiles 提示只在 data.json 真的有时出现（present={legacy_present}）：{rep['legacyWarning']}")
    if legacy_present:
        check("不会读取、不会自动迁移" in (rep["legacyWarning"] or ""),
              f"提示写明不读取、不自动迁移：{rep['legacyWarning']}")

    rows = rep["remoteRows"]
    repo_remotes = subprocess.run(["git", "-C", env["vaultPath"], "remote"], capture_output=True, text=True).stdout.split()
    check(rows is not None and len(rows) > 0, f"remote 设置里有 {0 if rows is None else len(rows)} 行")
    check(set(r["name"] for r in rows or []) >= set(repo_remotes),
          f"仓库里存在的 remote 都被识别出来了：仓库={repo_remotes} 设置页={[r['name'] for r in rows or []]}")
    check(rep.get("remoteAdd") == "添加 remote", "列表下方是「添加 remote」")
    check(rep["plainSettings"] == ["缩略图边长"], f"只有「缩略图边长」一个普通设置项：{rep['plainSettings']}")

    # 截图前先把设置窗口提到前台：窗口被遮挡/最小化时 Chromium 会推迟渲染，
    # Page.captureScreenshot 会一直等到 websocket 超时（实测 60s 挂死，判据全过但 exit=1）。
    subprocess.run(["osascript", "-e", 'tell application "Obsidian" to activate'], check=False)
    subprocess.run(["osascript", "-e",
                    'tell application "System Events" to tell process "Obsidian" '
                    'to perform action "AXRaise" of (first window whose name contains "设置")'], check=False)
    time.sleep(1.0)
    try:
        size = ui.js("(() => { const p = document.querySelector('.vertical-tab-content'); return JSON.stringify({h: Math.min(2400, Math.ceil(p.scrollHeight)+60), w: window.innerWidth}); })()")
        ui.call("Emulation.setDeviceMetricsOverride", width=size["w"], height=size["h"], deviceScaleFactor=2, mobile=False)
        time.sleep(0.4)
        shot = ui.call("Page.captureScreenshot", format="png", captureBeyondViewport=True)
        with open(SHOT, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        ui.call("Emulation.clearDeviceMetricsOverride")
        print(f"\n截图：{SHOT}（{size['w']}x{size['h']} css px @2x）—— 观感要人眼看这一张")
    except Exception as exc:  # 截图不是判据：抓不到不影响 PASS/FAIL，但要明说，别假装有图
        print(f"\n⚠ 截图没抓到（{type(exc).__name__}: {exc}）—— 判据结果不受影响。"
              "窗口被遮挡时 Chromium 会卡住 capture；把设置窗口点到最前再重跑。")
    print(f"\nREAL-GUI PASS={pass_count} FAIL={fail_count}")
    return 1 if fail_count else 0


if __name__ == "__main__":
    sys.exit(main() or 0)
