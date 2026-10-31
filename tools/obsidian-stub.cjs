/**
 * A minimal stand-in for the `obsidian` module, so the built main.js can be
 * loaded and exercised under plain Node (see smoke-test.cjs).
 *
 * It implements what the plugin touches: Plugin lifecycle, addCommand,
 * addSettingTab, the workspace "file-menu" event, Menu/MenuItem, Notice,
 * Modal, Setting (text / textarea / dropdown / button), TFolder/TFile, plus a
 * tiny DOM (`FakeEl`) good enough to build and inspect the settings tab and the
 * right-click modal headlessly.
 */
const fs = require("fs");
const path = require("path");

const registry = {
  commands: [],
  menus: [],
  tabs: [],
  notices: [],
  modals: [],
  savedData: null,
  statusBarItems: [],
  intervals: [],
  domEvents: [],
  windowIntervals: [],
  /** `getLanguage()` 的返回值（测试改它来验证「创建画廊」/「Create Gallery」两种标题）。 */
  language: "zh",
  /** 通过 workspace.getLeaf().openFile() 打开过的 vault 相对路径（按打开顺序）。 */
  opened: [],
};

/**
 * 与 Obsidian 的 `normalizePath` 同口径：反斜杠转正斜杠、去掉重复与首尾斜杠。
 * 插件用它在 `createVaultFile` 里规整用户输入的模板路径。
 */
function normalizePath(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** 真实 API 的 `getLanguage()`：返回当前 Obsidian 界面语言（如 "zh" / "en"）。 */
function getLanguage() {
  return registry.language;
}

/** Minimal element: enough of the Obsidian HTMLElement API for the UI code. */
class FakeEl {
  constructor(tag, opts) {
    opts = opts || {};
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.classes = [];
    this._listeners = {};
    this._text = "";
    this._value = "";
    this.placeholder = "";
    this._type = opts.type || "";
    this.parentElement = null;
  }

  get type() {
    return this._type;
  }
  set type(value) {
    this._type = value;
  }
  get value() {
    return this._value;
  }
  set value(value) {
    this._value = String(value);
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
  }

  createEl(tag, opts, callback) {
    let o = {};
    if (typeof opts === "string") o = { cls: opts };
    else if (opts && typeof opts === "object") o = opts;
    const el = new FakeEl(tag, o);
    if (o.cls !== undefined) el.addClass(...[].concat(o.cls));
    if (o.text !== undefined) el._text = String(o.text);
    if (o.type !== undefined) el._type = o.type;
    if (o.value !== undefined) el._value = String(o.value);
    if (o.placeholder !== undefined) el.placeholder = o.placeholder;
    if (o.attr !== undefined) for (const key of Object.keys(o.attr)) el.setAttr(key, o.attr[key]);
    el.parentElement = this;
    this.children.push(el);
    if (typeof callback === "function") callback(el);
    return el;
  }
  createDiv(opts, callback) {
    return this.createEl("div", opts, callback);
  }
  createSpan(opts, callback) {
    return this.createEl("span", opts, callback);
  }
  empty() {
    this.children = [];
    return this;
  }
  setText(text) {
    this._text = String(text);
    return this;
  }
  addClass(...classes) {
    for (const cls of classes) {
      for (const part of String(cls).split(/\s+/)) if (part) this.classes.push(part);
    }
    return this;
  }
  addClasses(classes) {
    return this.addClass(...classes);
  }
  removeClass(cls) {
    this.classes = this.classes.filter((c) => c !== cls);
    return this;
  }
  hasClass(cls) {
    return this.classes.includes(cls);
  }
  setAttr(name, value) {
    if (value === null || value === false) delete this.attributes[name];
    else this.attributes[name] = String(value);
    return this;
  }
  getAttr(name) {
    return this.attributes[name];
  }
  setAttribute(name, value) {
    return this.setAttr(name, value);
  }
  getAttribute(name) {
    return this.attributes[name] === undefined ? null : this.attributes[name];
  }
  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    return this;
  }
  removeEventListener(type, fn) {
    if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    return this;
  }
  focus() {}
  click() {
    const evt = { type: "click", target: this, preventDefault() {} };
    for (const fn of this._listeners.click || []) fn(evt);
  }
  dispatchEvent(evt) {
    evt = evt || {};
    evt.target = evt.target || this;
    if (typeof evt.preventDefault !== "function") evt.preventDefault = () => {};
    for (const fn of this._listeners[evt.type] || []) fn(evt);
    return true;
  }
}

/** Depth-first list of every descendant (root excluded). */
function walk(root, out) {
  out = out || [];
  for (const child of root.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

class TAbstractFile {
  constructor(path) {
    this.path = path;
  }
}
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
  }
  isRoot() {
    return this.path === "/";
  }
}
class FileSystemAdapter {
  constructor(base) {
    this.base = base;
  }
  getBasePath() {
    return this.base;
  }
  /**
   * 真实 `FileSystemAdapter.write(relPath, data)`：按 vault 相对路径写盘。
   * 桩里顺手补建父目录（真实 API 要求目录已存在；插件只在已存在的文件夹里走这条路，
   * 补建只是让测试写模板更省事）。
   */
  async write(relPath, data) {
    const target = path.join(this.base, normalizePath(relPath));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(data), "utf8");
  }
}
class Notice {
  constructor(message) {
    this.message = String(message);
    registry.notices.push(this.message);
  }
  hide() {}
  setMessage(message) {
    this.message = String(message);
  }
}
class MenuItem {
  constructor() {
    this.title = "";
    this.icon = "";
    this.submenu = null;
  }
  setTitle(title) {
    this.title = title;
    return this;
  }
  setIcon(icon) {
    this.icon = icon;
    return this;
  }
  onClick(callback) {
    this.callback = callback;
    return this;
  }
  /**
   * 镜像 app 里 `MenuItem.prototype.setSubmenu()` 的真实实现（见 obsidian.asar）：
   * 只建一次子菜单、给父项打 `has-submenu`、并把父项的 click 变成 preventDefault
   * —— 也就是说点父项本身不执行任何动作。
   */
  setSubmenu() {
    if (this.submenu === null) {
      this.submenu = new Menu();
      this.hasSubmenu = true;
      this.callback = (evt) => evt.preventDefault();
    }
    return this.submenu;
  }
}
class Menu {
  constructor() {
    this.items = [];
  }
  addItem(build) {
    const item = new MenuItem();
    build(item);
    this.items.push(item);
    return this;
  }
}

function makeTextComponent(inputEl) {
  const component = {
    inputEl,
    setValue(value) {
      inputEl.value = value;
      return component;
    },
    getValue() {
      return inputEl.value;
    },
    setPlaceholder(placeholder) {
      inputEl.placeholder = placeholder;
      return component;
    },
    onChange(callback) {
      component._onChange = callback;
      inputEl.addEventListener("input", () => callback(inputEl.value));
      inputEl.addEventListener("change", () => callback(inputEl.value));
      return component;
    },
  };
  return component;
}

function makeDropdownComponent(selectEl) {
  const component = {
    selectEl,
    options: [],
    addOption(value, display) {
      const option = selectEl.createEl("option", { text: display });
      option.setAttr("value", value);
      component.options.push({ value: String(value), text: String(display) });
      return component;
    },
    setValue(value) {
      selectEl.value = value;
      return component;
    },
    getValue() {
      return selectEl.value;
    },
    onChange(callback) {
      component._onChange = callback;
      selectEl.addEventListener("change", () => callback(selectEl.value));
      return component;
    },
  };
  return component;
}

function makeToggleComponent(inputEl) {
  const component = {
    inputEl,
    setValue(value) {
      inputEl.checked = Boolean(value);
      inputEl.value = String(Boolean(value));
      return component;
    },
    getValue() {
      return Boolean(inputEl.checked);
    },
    onChange(callback) {
      component._onChange = callback;
      inputEl.addEventListener("change", () => callback(Boolean(inputEl.checked)));
      return component;
    },
    setTooltip() {
      return component;
    },
  };
  return component;
}

function makeButtonComponent(buttonEl) {
  const component = {
    buttonEl,
    setButtonText(text) {
      buttonEl.setText(text);
      return component;
    },
    setCta() {
      buttonEl.addClass("mod-cta");
      return component;
    },
    setWarning() {
      buttonEl.addClass("mod-warning");
      return component;
    },
    setIcon() {
      return component;
    },
    setTooltip() {
      return component;
    },
    onClick(callback) {
      buttonEl.addEventListener("click", callback);
      return component;
    },
  };
  return component;
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.settingEl =
      containerEl && typeof containerEl.createDiv === "function" ? containerEl.createDiv({ cls: "setting-item" }) : new FakeEl("div");
    this.components = [];
  }
  setName(name) {
    this.name = name;
    this.settingEl.setAttr("data-name", String(name));
    return this;
  }
  setDesc(desc) {
    this.desc = desc;
    return this;
  }
  setHeading() {
    return this;
  }
  setClass(cls) {
    this.settingEl.addClass(cls);
    return this;
  }
  setCta() {
    return this;
  }
  setButtonText(text) {
    this.buttonText = text;
    return this;
  }
  onClick(callback) {
    this._onClick = callback;
    return this;
  }
  addText(build) {
    const component = makeTextComponent(this.settingEl.createEl("input", { cls: "setting-text", type: "text" }));
    this.components.push(component);
    build(component);
    return this;
  }
  addTextArea(build) {
    const component = makeTextComponent(this.settingEl.createEl("textarea", { cls: "setting-textarea" }));
    this.components.push(component);
    build(component);
    return this;
  }
  addDropdown(build) {
    const component = makeDropdownComponent(this.settingEl.createEl("select", { cls: "setting-dropdown" }));
    this.components.push(component);
    build(component);
    return this;
  }
  addToggle(build) {
    const component = makeToggleComponent(this.settingEl.createEl("input", { cls: "setting-toggle", type: "checkbox" }));
    this.components.push(component);
    build(component);
    return this;
  }
  addButton(build) {
    const component = makeButtonComponent(this.settingEl.createEl("button", { cls: "setting-button" }));
    this.components.push(component);
    build(component);
    return this;
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new FakeEl("div");
  }
  display() {}
}

class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = new FakeEl("div");
    this.modalEl = new FakeEl("div");
    this.contentEl = new FakeEl("div");
    this.titleEl = new FakeEl("div");
  }
  setTitle(title) {
    this.titleEl.setText(title);
    return this;
  }
  open() {
    registry.modals.push(this);
    if (typeof this.onOpen === "function") this.onOpen();
  }
  close() {
    if (typeof this.onClose === "function") this.onClose();
  }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return registry.savedData === null ? null : JSON.parse(JSON.stringify(registry.savedData));
  }
  async saveData(data) {
    registry.savedData = JSON.parse(JSON.stringify(data));
  }
  addCommand(command) {
    registry.commands.push(command);
  }
  addSettingTab(tab) {
    registry.tabs.push(tab);
  }
  /** 状态栏那一行：真实 API 无参、返回一个空 `<div class="status-bar-item">`。 */
  addStatusBarItem() {
    const el = new FakeEl("div");
    el.addClass("status-bar-item");
    registry.statusBarItems.push(el);
    return el;
  }
  registerEvent() {}
  registerDomEvent(el, type, callback) {
    // 真实 API 会把 handler 挂到元素上并在卸载时摘掉；桩里照挂，好让测试能 click()。
    registry.domEvents.push({ el, type });
    if (el && typeof el.addEventListener === "function") el.addEventListener(type, callback);
  }
  /**
   * 真实 API 收的是 `setInterval` 的 id（卸载时 clearInterval）。桩里记下这个 id，
   * 测试可以读 `_idleTimeout` 复核间隔毫秒（见 smoke-test 的状态栏一节）。
   */
  registerInterval(id) {
    registry.intervals.push(id);
  }
}

/** `setIcon(el, iconId)`：真实实现在元素里塞一个 `<svg>`；桩里只记 `data-icon`。 */
function setIcon(el, iconId) {
  if (el === undefined || el === null) return;
  el.addClass("svg-icon");
  el.setAttr("data-icon", String(iconId));
  if (el.children.length === 0) el.createEl("svg", { cls: `lucide-${String(iconId)}` });
}

/**
 * `app`：vault 真的落在 `vaultPath` 那个目录上。
 *
 * 插件现在会自己写文件（「复制为自定义」模板、创建画廊时写 .base），所以 `vault.*`
 * 必须与磁盘一致 —— 桩里直接转成 fs 调用，而不是只记一笔。`getAbstractFileByPath`
 * 返回真实的 `TFile` / `TFolder` 实例，因为插件用 `instanceof TFile` 判断走哪条路。
 */
function makeApp(vaultPath) {
  const base = vaultPath;
  const absOf = (rel) => path.join(base, normalizePath(rel));
  const adapter = new FileSystemAdapter(base);

  const vault = {
    adapter,
    getName() {
      return path.basename(base.replace(/[\\/]+$/, "")) || base;
    },
    getAbstractFileByPath(rel) {
      const norm = normalizePath(rel);
      if (norm === "" || norm === "/") return new TFolder("/");
      let stat;
      try {
        stat = fs.statSync(absOf(norm));
      } catch {
        return null;
      }
      return stat.isDirectory() ? new TFolder(norm) : new TFile(norm);
    },
    async create(rel, text) {
      const norm = normalizePath(rel);
      const target = absOf(norm);
      if (fs.existsSync(target)) throw new Error(`File already exists: ${norm}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(text), "utf8");
      return new TFile(norm);
    },
    async modify(file, text) {
      fs.writeFileSync(absOf(file.path), String(text), "utf8");
    },
    async createFolder(rel) {
      const norm = normalizePath(rel);
      fs.mkdirSync(absOf(norm), { recursive: true });
      return new TFolder(norm);
    },
  };

  return {
    vault,
    workspace: {
      on(name, callback) {
        if (name === "file-menu") registry.menus.push(callback);
        return { name };
      },
      /** 真实 API 返回一个 leaf；测试只关心 `openFile()` 被调用（路径记进 registry.opened）。 */
      getLeaf() {
        return {
          async openFile(file) {
            registry.opened.push(file.path);
          },
        };
      },
    },
  };
}

/**
 * 最小 `window`：Obsidian 插件跑在 Electron 的渲染进程里，用 `window.setInterval` 是正常写法
 * （`this.registerInterval(window.setInterval(...))`）。桩里**不能**真挂 interval —— 那会把测试进程
 * 吊住 —— 所以只发一个 id；`setTimeout` / `clearTimeout` 直接转发给 Node（debounce 照常工作）。
 *
 * 发的 id 连同**间隔毫秒**记进 `registry.windowIntervals`：测试要能断言「插件真的按 30 秒轮询」，
 * 而不是只看插件自己字段里写的数字。
 */
if (globalThis.window === undefined) {
  const liveIntervals = new Set();
  let nextIntervalId = 1;
  globalThis.window = {
    setInterval(_fn, ms) {
      const id = nextIntervalId;
      nextIntervalId += 1;
      liveIntervals.add(id);
      registry.windowIntervals.push({ id, ms });
      return id;
    },
    clearInterval(id) {
      liveIntervals.delete(id);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

module.exports = {
  TAbstractFile,
  TFile,
  TFolder,
  FileSystemAdapter,
  Notice,
  Menu,
  MenuItem,
  Setting,
  PluginSettingTab,
  Modal,
  Plugin,
  setIcon,
  getLanguage,
  normalizePath,
  FakeEl,
  walk,
  registry,
  makeApp,
};
