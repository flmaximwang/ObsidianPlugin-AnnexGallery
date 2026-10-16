#!/usr/bin/env python3
"""状态栏那一行的**真机**判据（CDP over `--remote-debugging-port`）。

离屏那一套（`npm run smoke` / `npm run verify:status`）量的是「DOM 结构 + 三个数字」；颜色、几何、
点击是否真触发刷新只能在跑着的 Obsidian 里量 —— 这个脚本就干这个，判据与 docs/status-bar.md 的
「真机复核」一节逐条对应。

  python3 tools/status-gui-check.py                    # 只读：那一行在不在 + 文字/几何/配色/提示
  python3 tools/status-gui-check.py --vault Data_lab_10
  python3 tools/status-gui-check.py --click            # 再点一下那一行，验证「点了会刷新」（约 0.1 秒内 busy 翻 true）
  python3 tools/status-gui-check.py --reload           # 先关/开一次插件再量（**会改运行中的 app 状态**）

前置：Obsidian 必须以 `--remote-debugging-port=9333`（或 --port 指定的端口）启动 —— 这个开关
**只在启动时生效**，所以要先真退出 Obsidian 再带参数打开：

  osascript -e 'quit app "Obsidian"'
  open -na /Applications/Obsidian.app --args --remote-debugging-port=9333 --remote-allow-origins=*

需要 `python3` + `websocket-client`（见 skill `inspect-obsidian-gui-with-maxim`）。默认只读；
`--click` / `--reload` 会驱动运行中的 app，所以不做默认。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    sys.exit("缺少依赖：pip install websocket-client")

APP_PAGE = "app://obsidian.md/index.html"

PASS = 0
FAIL = 0


def check(ok: bool, msg: str) -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {msg}")
    else:
        FAIL += 1
        print(f"  ✗ {msg}")


READ = r"""
(() => {
  const el = document.querySelector('.annex-status-bar');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  const counts = el.querySelector('.annex-status-counts');
  const icon = el.querySelector('.annex-status-refresh');
  const svg = el.querySelector('svg');
  const body = getComputedStyle(document.body);
  const bar = el.parentElement;
  const siblings = bar ? [...bar.querySelectorAll('.status-bar-item')].filter((i) => i !== el) : [];
  const r = el.getBoundingClientRect();
  const ics = icon ? getComputedStyle(icon) : null;
  const scs = svg ? getComputedStyle(svg) : null;
  const ccs = counts ? getComputedStyle(counts) : null;
  return {
    found: true,
    vault: app.vault.getName ? app.vault.getName() : '(n/a)',
    text: el.textContent.trim(),
    dataLevel: el.getAttribute('data-level'),
    dataBusy: el.getAttribute('data-busy'),
    ariaLabel: el.getAttribute('aria-label') || '',
    box: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    item: { display: cs.display, alignItems: cs.alignItems, gap: cs.gap, cursor: cs.cursor, height: cs.height, padding: cs.padding },
    counts: ccs ? { color: ccs.color, fontVariantNumeric: ccs.fontVariantNumeric, whiteSpace: ccs.whiteSpace } : null,
    icon: ics ? { display: ics.display, color: ics.color, opacity: ics.opacity } : null,
    svg: scs ? { width: scs.width, height: scs.height } : null,
    siblingHeight: siblings.length ? getComputedStyle(siblings[0]).height : null,
    tokens: {
      iconS: body.getPropertyValue('--icon-s').trim(),
      size22: body.getPropertyValue('--size-2-2').trim(),
      textFaint: body.getPropertyValue('--text-faint').trim(),
      textNormal: body.getPropertyValue('--text-normal').trim(),
      textWarning: body.getPropertyValue('--text-warning').trim(),
    },
  };
})()
"""

RELOAD = """
(async () => {
  const id = 'annex-gallery';
  const before = !!document.querySelector('.annex-status-bar');
  await app.plugins.disablePlugin(id);
  await app.plugins.enablePlugin(id);
  return { hadItemBefore: before, enabled: !!(app.plugins && app.plugins.plugins[id]) };
})()
"""

CLICK = """
(async () => {
  const el = document.querySelector('.annex-status-bar');
  if (!el) return { error: 'no .annex-status-bar' };
  el.click();
  await new Promise((r) => setTimeout(r, 150));
  return { busy: el.getAttribute('data-busy'), level: el.getAttribute('data-level') };
})()
"""

TEXT_RE = r"^未提交 \d+ · 未跟踪 \d+ · 未入库 largefiles (\d+|\?)$"


class Client:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=120, max_size=64 * 1024 * 1024)
        self.n = 0

    def call(self, method: str, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                res = msg.get("result", {})
                if "exceptionDetails" in res:
                    raise RuntimeError(str(res["exceptionDetails"])[:400])
                return res.get("result", {}).get("value")

    def ev(self, expr: str, await_promise: bool = False):
        return self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=await_promise)

    def close(self) -> None:
        self.ws.close()


def app_targets(port: int) -> list:
    url = "http://127.0.0.1:%d/json/list" % port
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            targets = json.load(r)
    except urllib.error.URLError as e:
        sys.exit(f"连不上 {url}：{e}\n-> Obsidian 必须带 --remote-debugging-port={port} 启动（只在启动时生效）")
    return [t for t in targets if t.get("url", "").startswith(APP_PAGE)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9333)
    ap.add_argument("--vault", help="只量标题里含这个子串的那个窗口")
    ap.add_argument("--click", action="store_true", help="点一下那一行，验证「点了会刷新」（约 5 秒）")
    ap.add_argument("--reload", action="store_true", help="先关/开一次插件（会改运行中的 app 状态）")
    args = ap.parse_args()

    windows = app_targets(args.port)
    if args.vault:
        windows = [t for t in windows if args.vault in t.get("title", "")]
    if not windows:
        sys.exit("没有可量的窗口（用 --vault 换个名字？）")

    for target in windows:
        print("==", target.get("title"))
        c = Client(target["webSocketDebuggerUrl"])
        try:
            if args.reload:
                print("   重载插件 →", c.ev(RELOAD, await_promise=True))
                deadline = time.time() + 60
                while time.time() < deadline and not c.ev(READ).get("found"):
                    time.sleep(0.5)
            state = c.ev(READ)
            if not state.get("found"):
                check(False, "这个窗口有 .annex-status-bar（没找到 —— 插件没启用？还是还是旧构建？用 --reload 试试）")
                continue

            check(True, "那一行在 DOM 里（.status-bar-item.annex-status-bar）")
            check(re.match(TEXT_RE, state["text"]) is not None or state["text"].startswith(("未初始化", "无法统计")),
                  f"文字是「{state['text']}」")
            check(state["dataLevel"] in ("zero", "dirty", "uninitialized", "unavailable", "loading"),
                  f"data-level = {state['dataLevel']}（零/有数/未初始化/不可统计/统计中 五档之一）")
            check(state["counts"] is not None and state["counts"]["fontVariantNumeric"] == "tabular-nums",
                  f"数字等宽（font-variant-numeric={state['counts'] and state['counts']['fontVariantNumeric']}）")
            check(state["counts"] is not None and state["counts"]["whiteSpace"] == "nowrap", "文字不换行（nowrap）")
            check(state["icon"] is not None and state["icon"]["display"] in ("flex", "inline-flex"),
                  "刷新图标是 flex 盒（与文字垂直居中）")
            check(state["svg"] is not None and state["svg"]["width"] == state["tokens"]["iconS"],
                  f"图标尺寸 = --icon-s（{state['svg'] and state['svg']['width']}）")
            check(state["item"]["cursor"] == "pointer", "整行可点（cursor: pointer）")
            check(state["item"]["alignItems"] == "center", "整行 align-items: center")
            check(state["item"]["gap"] == state["tokens"]["size22"],
                  f"文字与图标间距 = --size-2-2（{state['item']['gap']}）")
            check(state["box"]["width"] > 0 and state["box"]["height"] > 0,
                  f"盒子 {state['box']['width']} × {state['box']['height']} px @ ({state['box']['left']}, {state['box']['top']})")
            sibling_px = re.match(r"^([\d.]+)px$", state.get("siblingHeight") or "")
            if sibling_px:
                check(state["box"]["height"] == int(float(sibling_px.group(1))),
                      f"与其它状态栏项等高（{state['siblingHeight']}）")
            else:
                print(f"     （其它状态栏项量不出高度：{state['siblingHeight']!r} —— 跳过等高断言）")
            check("未提交" in state["ariaLabel"] and "未入库 largefiles" in state["ariaLabel"],
                  "悬停提示写着三项的口径")
            check("每 30 秒自动刷新" in state["ariaLabel"], "悬停提示写着 30 秒轮询 / 点击刷新")
            check(all(state["tokens"].values()), f"用到的 CSS 变量都在：{state['tokens']}")
            print(f"     文字：{state['text']}")

            if args.click:
                after = c.ev(CLICK, await_promise=True)
                check(after.get("busy") == "true",
                      f"点一下那一行 → data-busy 立刻变 true（{after}）")
                deadline = time.time() + 60
                settled = None
                while time.time() < deadline:
                    settled = c.ev(READ)
                    if settled.get("dataBusy") == "false":
                        break
                    time.sleep(0.5)
                check(settled is not None and settled.get("dataBusy") == "false",
                      f"这趟跑完了（data-busy=false，文字「{settled and settled.get('text')}」）")
        finally:
            c.close()

    print(f"\nPASS={PASS} FAIL={FAIL}")
    if FAIL == 0:
        print("STATUS-GUI OK")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
