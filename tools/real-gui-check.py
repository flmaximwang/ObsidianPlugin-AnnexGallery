#!/usr/bin/env python3
"""真机（跑着的 Obsidian）复核 Annex Gallery 设置页 —— 离屏量不出来的那几项。

    # 先带调试端口重启 Obsidian（端口只在启动时生效），例如 9333：
    osascript -e 'quit app "Obsidian"'
    open -na /Applications/Obsidian.app --args --remote-debugging-port=9333 "--remote-allow-origins=*"
    python3 tools/real-gui-check.py [vault 名（默认 Data_lab_10）]

为什么需要它（离屏 tools/layout-check.cjs 覆盖不到）：
  * 原生 `<select>` 的宽度由**最长选项文字**决定 —— 桩环境里 option 没有文字，离屏量出来是 41px，
    真机里 TECNAI 那条是 464px（会把工具条挤成两行）。只有真机能量准。
  * `openWithDefaultApp` 这类**运行时行为**（绝对路径 vs vault 相对路径）只能在真机验。
  * 观察观感（配色、空旷感）最终要人眼看截图；本脚本负责把截图生成出来 + 把结构判据钉死。

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
  const bar = pane.querySelector('.annex-profiles-toolbar');
  const remotes = pane.querySelector('.annex-remotes-card');
  const h1 = pane.querySelector('.annex-settings-title');
  return {
    contentLeft: +((pane.getBoundingClientRect().left) + parseFloat(cs(pane,'paddingLeft'))).toFixed(1),
    contentRight: +((pane.getBoundingClientRect().right) - parseFloat(cs(pane,'paddingRight'))).toFixed(1),
    topLevel: [...pane.children].map(c => c.tagName + '.' + c.className),
    h1: h1 ? {text: h1.textContent.trim(), display: cs(h1,'display'), left: box(h1).left, padL: cs(h1,'paddingLeft'), height: box(h1).height} : null,
    toolbar: bar ? {justify: cs(bar,'justifyContent'), wrap: cs(bar,'flexWrap'), box: box(bar),
      controls: [...bar.children].filter(c => cs(c,'display') !== 'none').map(c => ({tag: c.tagName, label: c.tagName === 'SELECT' ? c.options[0].text : c.textContent.trim(), box: box(c)}))} : null,
    remoteRows: remotes ? [...remotes.querySelectorAll('.annex-remote-row')].map(r => ({name: r.querySelector('.annex-remote-name').value, url: r.querySelector('.annex-remote-url').value, box: box(r)})) : null,
    remoteAdd: remotes ? remotes.querySelector('.annex-remote-add').textContent.trim() : null,
    actions: [...pane.querySelectorAll('.annex-profile-actions button')].map(b => ({label: b.textContent.trim(), box: box(b)})),
    actionsJustify: cs(pane.querySelector('.annex-profile-actions'),'justifyContent'),
    status: pane.querySelector('.annex-profile-status') ? pane.querySelector('.annex-profile-status').textContent.trim() : null,
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
      return {vault: app.vault.getName(), vaultPath: app.vault.adapter.getBasePath(), loaded: Boolean(p),
              version: p ? p.manifest.version : null, settingsKeys: p ? Object.keys(p.settings) : null,
              remotes: p ? p.settings.remotes : null};
    })())""")
    print(f"主窗口：{main_t['title']}\nvault：{env.get('vaultPath')}  插件 0.1.0 loaded={env.get('loaded')}")
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

    print("\n真机结构判据：")
    check(rep["h1"] is not None and rep["h1"]["display"] != "none" and rep["h1"]["height"] > 0,
          f"标题可见（app.css 有 .vertical-tab-content h1{{display:none}}，必须被压掉）：{rep['h1']}")
    check(rep["h1"] is not None and abs(rep["h1"]["left"] - rep["contentLeft"]) < 0.5,
          f"标题与内容左边缘对齐：{rep['h1']['left'] if rep['h1'] else '?'} vs {rep['contentLeft']}")
    expected_order = ["annex-settings-title", "annex-remotes-section", "annex-remotes-divider",
                      "annex-profiles-section", "annex-settings-divider", "setting-item"]
    got = [c.split(".", 1)[1].split(" ")[0] for c in rep["topLevel"]]
    check(got == expected_order,
          f"顶层顺序 = 标题 → remote 设置 → 分割线 → 模版设置 → 分割线 → 缩略图边长：{rep['topLevel']}")

    bar = rep["toolbar"] or {}
    controls = bar.get("controls", [])
    check(bar.get("wrap") == "nowrap" and bar.get("justify") == "flex-start",
          f"工具条不换行且两端分开（按钮靠左、下拉靠右）：wrap={bar.get('wrap')} justify={bar.get('justify')}")
    check(len(controls) == 3 and len({c["box"]["top"] for c in controls}) == 1,
          f"三个控件在同一行（新模版 / 导入模版 / 添加预设）：{[c['label'] for c in controls]}")
    if controls:
        left_most = min(c["box"]["left"] for c in controls)
        check(abs(left_most - bar["box"]["left"]) < 1,
              f"最左的「新模版」贴住左边缘：{left_most} vs {bar['box']['left']}")
        sel = [c for c in controls if c["tag"] == "SELECT"]
        check(bool(sel) and abs(sel[-1]["box"]["right"] - bar["box"]["right"]) < 1,
              f"「添加预设」下拉贴住右边缘：{sel[-1]['box']['right'] if sel else '?'} vs {bar['box']['right']}")
        btns = [c for c in controls if c["tag"] == "BUTTON"]
        if btns and sel:
            gap = sel[-1]["box"]["left"] - max(b["box"]["right"] for b in btns)
            check(gap > 40, f"按钮组与下拉之间留出空隙（左一组、右一个）：{round(gap, 1)}px")
        select_width = [c["box"]["width"] for c in controls if c["tag"] == "SELECT"]
        check(bool(select_width) and select_width[0] < 260, f"「添加预设」下拉宽度已收窄：{select_width}")

    rows = rep["remoteRows"]
    repo_remotes = subprocess.run(["git", "-C", env["vaultPath"], "remote"], capture_output=True, text=True).stdout.split()
    check(rows is not None and len(rows) > 0, f"remote 设置里有 {0 if rows is None else len(rows)} 行")
    check(set(r["name"] for r in rows or []) >= set(repo_remotes),
          f"仓库里存在的 remote 都被识别出来了：仓库={repo_remotes} 设置页={[r['name'] for r in rows or []]}")
    check(rep.get("remoteAdd") == "添加 remote", "列表下方是「添加 remote」")

    acts = [a["label"] for a in rep["actions"]]
    check(acts == ["删除", "打开", "复制", "保存"] and rep["actionsJustify"] == "flex-end",
          f"卡片动作 DOM 顺序 删除→打开→复制→保存 且靠右下角：{acts} justify={rep['actionsJustify']}")
    check(rep["plainSettings"] == ["缩略图边长"], f"只有「缩略图边长」一个普通设置项：{rep['plainSettings']}")

    # 解析预览的真机行为：用户报的样例（中间段带下划线 + 小数点、且不带扩展名）。
    # 老实现会把 `.4-0001` 当扩展名吃掉（stem 削成 `12345X-5_1`）⇒ 明明该命中却显示「正则不命中」。
    prev = ui.js(r"""JSON.stringify((() => {
      const inp = document.querySelector('.annex-preview-filename');
      if (!inp) return { error: '没有预览输入框' };
      inp.value = '12345X-5_1.4-0001';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const box = document.querySelector('.annex-preview-result');
      const rows = [...document.querySelectorAll('.annex-preview-row')]
        .map((r) => [r.getAttribute('data-key'), r.getAttribute('data-value')]);
      return { state: box ? box.getAttribute('data-state') : null, rows: Object.fromEntries(rows) };
    })())""")
    prev_rows = prev.get("rows") or {}
    check(prev.get("state") == "ok",
          f"真机预览：12345X-5_1.4-0001 命中（state={prev.get('state')}）{prev}")
    check(prev_rows.get("marker") == "5_1.4", f"真机预览 marker=5_1.4：{prev_rows}")
    check(prev_rows.get("index") == "1", f"真机预览 index 按 number 规整（0001 → 1）：{prev_rows}")

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
