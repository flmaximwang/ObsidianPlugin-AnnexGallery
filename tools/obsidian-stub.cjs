/**
 * A minimal stand-in for the `obsidian` module, so the built main.js can be
 * loaded and exercised under plain Node (see smoke-test.cjs).
 *
 * It only implements what main.ts touches: Plugin lifecycle, addCommand,
 * addSettingTab, the workspace "file-menu" event, Menu/MenuItem, Notice,
 * Modal, Setting and TFolder/TFile.
 */
const registry = { commands: [], menus: [], tabs: [], notices: [] };

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
const textComponent = () => {
  const component = {
    setValue() {
      return component;
    },
    setPlaceholder() {
      return component;
    },
    onChange() {
      return component;
    },
    inputEl: { focus() {}, addEventListener() {} },
  };
  return component;
};
class Setting {
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setCta() {
    return this;
  }
  setButtonText() {
    return this;
  }
  onClick() {
    return this;
  }
  addText(build) {
    build(textComponent());
    return this;
  }
  addButton(build) {
    build(this);
    return this;
  }
}
class PluginSettingTab {
  constructor(app) {
    this.app = app;
    this.containerEl = { empty() {} };
  }
  display() {}
}
class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = { empty() {}, createEl() {} };
    this.titleEl = { setText() {} };
  }
  open() {
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
    return null;
  }
  async saveData() {}
  addCommand(command) {
    registry.commands.push(command);
  }
  addSettingTab(tab) {
    registry.tabs.push(tab);
  }
  registerEvent() {}
}

function makeApp(vaultPath) {
  return {
    vault: { adapter: new FileSystemAdapter(vaultPath) },
    workspace: {
      on(name, callback) {
        if (name === "file-menu") registry.menus.push(callback);
        return { name };
      },
    },
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
  registry,
  makeApp,
};
