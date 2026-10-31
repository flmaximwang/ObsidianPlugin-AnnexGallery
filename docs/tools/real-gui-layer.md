# 真机层：在跑着的 Obsidian 里量

只有一样东西值得放到这一层：**桩与离屏在物理上量不出来的项**。它慢、依赖一台开着的 Obsidian，
所以每加一条断言都要先回答「桩层为什么不行」。

## 前置：带调试端口的 Obsidian

```bash
osascript -e 'quit app "Obsidian"'
open -na /Applications/Obsidian.app --args --remote-debugging-port=<port> "--remote-allow-origins=*"
```

调试端口**只在启动时生效**，所以必须先真退出再带参数打开；端口起来后两个脚本都通过
Chrome DevTools Protocol 连进去（需要 `websocket-client`）。

## 两档：只读与驱动

- **默认只读**：连上去只做查询（元素在不在、文字、computed style、盒子几何、`aria-label`）。
  只读不该改变 app 的任何状态。
- **显式驱动才是可选项**：`--click`（点一下目标元素，验证「点了真的会刷新」）、
  `--reload`（关/开一次插件，让新构建进内存）。这两条会改运行中的 app 状态，
  所以默认关闭、且由调用者显式打开。

## 判什么

| 脚本 | 钉住 |
|---|---|
| `status-gui-check.py`（`npm run gui:status`） | 状态栏那一行的文字形态、`data-level` 五档之一、数字等宽、图标与文字垂直居中、整行可点、盒子高度与同行其它项一致、悬停提示写着三项定义 |
| `real-gui-check.py`（`npm run gui`） | 设置页在真机里的几何（原生 `<select>` 按最长选项定宽）、工具条是否被挤成两行、**设置页渲染的行数与 `data.json` 里登记的外部文件一一对应**、没有旧内联编辑器 / 内置模板行、观察用的截图 |

## 三条纪律

1. **量的是渲染结果，不是源码。** 结论必须来自 DOM / computed style / 截图，不能来自「CSS 里应该是这样」。
2. **观感要人看截图。** 脚本负责把截图生成出来 + 把结构判据钉死；配色、空旷感这类结论由人给。
3. **重载之后的读数要等稳定。** 刚 `enablePlugin` 完是 loading 态（文字与 `aria-label` 都还没落位），
   直接断言会得到假失败 —— 先轮询到稳定状态再量。

## 与桩层的边界（常见误判）

- 原生控件的宽度：**只在真机能量**（桩里 option 没有文字，量出来是常量）。
- 外部应用的打开行为：**脚本不点「打开」** —— 那会拉起系统默认应用；成功 / 失败由桩层用可替换的
  `openWithDefaultApp` 覆盖（见 `tools/smoke-test.cjs`）。
- 其余「元素在不在、class 对不对、文字是什么」：**都在桩层判**，别搬到这里来拖慢回归。
