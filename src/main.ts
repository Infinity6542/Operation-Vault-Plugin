import {
  App,
  debounce,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { connect, disconnect, startHeartbeats } from "./transport";
import { remove } from "./comm";
import { sendFileChunked } from "./fileHandler";
import { SyncHandler, cursorPlugin } from "./syncHandler";
import type {
  SharedItem,
  PluginSettings,
  IOpVaultPlugin,
  Manifest,
} from "./types";
import { FolderSelector, ShareModal, DownloadModal, ConfirmModal } from "./components";
import { HistoryView, VIEW_TYPE_HISTORY } from "./views";
import { joinChannel, leaveChannel } from "./networking";

export type { SharedItem };

const defaultSettings: PluginSettings = {
  serverUrl: "https://opal.jchen.au:8080/ws",
  channelName: "vault-1",
  encryptionKey: "default",
  senderId: "",
  sharedItems: [],
  inboxPath: "",
  syncGroups: [],
  nickname: "",
  devMode: false,
  certHash: "",
};

export function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// function generateKey(): string {
//  	return (
// 		Math.random().toString(36).substring(2, 15) +
// 		Math.random().toString(36).substring(2, 15)
// 	);
// }

export default class OpVaultPlugin extends Plugin implements IOpVaultPlugin {
  settings!: PluginSettings;
  activeWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  activeTransport: WebTransport | null = null;
  activeDownloads: Map<string, string> = new Map();
  heartbeatInterval: ReturnType<typeof setTimeout> | null = null;
  syncHandler!: SyncHandler;
  statusBarItem!: HTMLElement;
  onlineUsers: Map<string, string> = new Map();
  channelUsers: Map<string, Set<string>> = new Map();
  manifests: Map<string, Manifest> = new Map();

  async onload() {
    console.debug("[OPV] Loading client...");
    await this.loadSettings();

    if (!this.settings.senderId) {
      this.settings.senderId = generateUUID();
      await this.saveSettings();
      console.debug(`[OPV] Generated new sender ID: ${this.settings.senderId}`);
    }

    this.syncHandler = new SyncHandler(this.app, this);
    this.syncHandler.setupGlobalListeners();

    this.addSettingTab(new vaultSettingsTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.updatePresence(0);
    this.statusBarItem.addClass("mod-clickable");
    this.statusBarItem.addEventListener("click", () => {
      if (this.onlineUsers.size > 0) {
        let userList = Array.from(this.onlineUsers.values()).join("\n");
        console.debug(this.onlineUsers);
        new Notice(`Online users:\n${userList}`);
      } else {
        new Notice("No other users online.");
      }
    });

    this.addRibbonIcon("paper-plane", "Send file", async () => {
      if (!this.activeWriter) {
        new Notice("Not connected to server.");
        console.debug("[OPV] No active writer found.");
        return;
      }

      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile) {
        new Notice("Open a file to send it!");
        console.debug("[OPV] Active file is not a TFile.");
        return;
      }

      await sendFileChunked(
        this.activeWriter,
        this.settings.channelName,
        activeFile,
        this.app,
        this,
        this.settings.encryptionKey,
      );
    });

    this.addRibbonIcon("link", "Share file", async () => {
      //* As part of the temporary UI overhaul, the user can now select the file(s)
      //* they want to share within the modal!
      const activeFile = this.app.workspace.getActiveFile();
      new ShareModal(this.app, this, activeFile).open();
    });

    this.addRibbonIcon("download", "Download shared item", async () => {
      new DownloadModal(this.app, this).open();
    });

    this.registerEditorExtension(cursorPlugin(this.app));

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void (async () => {
          if (!file) return;

          const shareObjects = this.settings.sharedItems.filter(
            (item) => item.path === file.path,
          );

          for (let i = 0; i < shareObjects.length; i++) {
            console.debug(
              `[OPV] File opened is shared: ${file.path} (${i + 1}/${shareObjects.length
              })`,
            );
            if (this.activeWriter) {
              await this.syncHandler.startSync(file);
            }
          }
        })();
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!file || !(file instanceof TFile)) return;

        // Find the shared item by the old path (before rename)
        const sharedItem = this.settings.sharedItems.filter(
          (item) => item.path === oldPath,
        );
        if (!sharedItem) return;
        for (const item of sharedItem) {
          await this.syncHandler.handleRename(file, item);
          item.path = file.path;
          await this.saveSettings();
        }
        const groups = this.settings.syncGroups.filter((g) =>
          g.files.some((f) => f.id === sharedItem[0].id),
        );
        if (groups) {
          for (let i = 0; i < groups.length; i++) {
            await this.syncHandler.updateMap(groups[i]);
          }
        }
        console.debug(
          `[OPV] File moved or renamed: ${oldPath} -> ${file.path}`,
        );
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (!file || !(file instanceof TFile)) return;
        for (
          let i = 0;
          i <
          this.settings.sharedItems.filter((item) => item.path === file.path)
            .length;
          i++
        ) {
          const sharedItemIndex = this.settings.sharedItems.findIndex(
            (item) => item.path === file.path,
          );
          if (sharedItemIndex === -1 || !this.activeWriter) return;
          await remove(this, this.settings.sharedItems[sharedItemIndex].id);
          await leaveChannel(
            this.activeWriter,
            this.settings.sharedItems[sharedItemIndex].id,
            this.settings.senderId,
          );
          this.settings.sharedItems.splice(sharedItemIndex, 1);
          const groups = this.settings.syncGroups.filter((group) =>
            group.files.some((f) => f.path === file.path),
          );
          for (const group of groups) {
            group.files = group.files.filter((f) => f.path !== file.path);
            if (group.files.length === 0) {
              await this.syncHandler.removeSyncGroup(group);
            } else {
              await this.syncHandler.updateMap(groups[i]);
            }
          }
          await this.saveSettings();
        }
        console.debug(`[OPV] File deleted: ${file.path}`);
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", async (file) => {
        if (!file || !(file instanceof TFile)) return;
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter: unknown = cache?.frontmatter?.["sync-group"];
        if (!frontmatter) return;

        const fileGroups: string[] = [];
        const trackingGroups = this.settings.syncGroups.filter((group) =>
          group.files.some((f) => f.path === file.path),
        );
        if (Array.isArray(frontmatter)) {
          frontmatter.forEach((g) => fileGroups.push(g as string));
        } else if (typeof frontmatter === "string") {
          const values = frontmatter.split(",").map((s) => s.trim());
          values.forEach((g) => fileGroups.push(g));
        } else {
          console.debug(
            `[OPV] Unhandled type for sync-group frontmatter in ${file.path
            }: ${typeof frontmatter}`,
          );
        }

        if (!this.activeWriter || !this.activeTransport) {
          console.debug(
            "[OPV] activeWriter or activeTransport (or both) is null. This is likely due to the lack of a server connection.",
          );
          return;
        }

        for (const group of trackingGroups) {
          if (Array.isArray(frontmatter)) {
            if (!fileGroups.includes(group.id)) {
              group.files = group.files.filter((f) => f.path !== file.path);
              if (group.files.length === 0) {
                await this.syncHandler.removeSyncGroup(group);
                continue;
              }
            }
          }
        }

        for (const group of fileGroups) {
          const syncGroup = this.settings.syncGroups.find(
            (g) => g.id === group,
          );
          if (!syncGroup) continue;
          if (syncGroup.files.some(f => f.path === file.path)) {
            continue;
          }
          let shareItem = {
            id: generateUUID(),
            path: file.path,
            pin: syncGroup?.pin ? syncGroup.pin : undefined,
            key: syncGroup?.pin ? syncGroup.pin : "",
            createdAt: Date.now(),
            shares: 0,
          };
          this.settings.sharedItems.push(shareItem);
          syncGroup.files.push(shareItem);
          await this.saveSettings();
          await joinChannel(
            this.activeWriter,
            group,
            this.settings.senderId,
            this.settings.nickname,
          );
        }

        const groups = this.settings.syncGroups.filter((g) =>
          g.files.some(
            (f) =>
              f.id ===
              this.settings.sharedItems.filter(
                (item) => item.path === file.path,
              )[0].id,
          ),
        );
        if (groups) {
          for (let i = 0; i < groups.length; i++) {
            await this.syncHandler.updateMap(groups[i]);
          }
        }
      }),
    );

    this.registerView(VIEW_TYPE_HISTORY, (leaf) => new HistoryView(leaf, this));

    this.addCommand({
      id: "open-history-view",
      name: "Open version history view",
      callback: async () => {
        await this.activateView();
      },
    });

    this.registerObsidianProtocolHandler("opv", async (params) => {
      console.debug("[OPV] Handling protocol action:", params);
      if (params.id) {
        new DownloadModal(this.app, this, params.id).open();
      }
    });

    await this.tryConnect();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_HISTORY);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_HISTORY, active: true });
      }
    }

    if (leaf) await workspace.revealLeaf(leaf);
  }

  async tryConnect() {
    if (this.activeTransport) {
      console.debug("[OPV] Already connected to server.");
      return;
    }
    try {
      this.activeTransport = await connect(
        this.settings.serverUrl,
        this.settings.channelName,
        this,
      );

      if (this.activeWriter) {
        console.debug("[OPV] Rejoining share channels.");
        for (const item of this.settings.sharedItems) {
          await joinChannel(
            this.activeWriter,
            item.id,
            this.settings.senderId,
            this.settings.nickname,
          );
          const file = this.app.vault.getAbstractFileByPath(item.path);
          if (file instanceof TFile) {
            await this.syncHandler.startSync(file, false, false, true);
          }
        }
        for (const group of this.settings.syncGroups) {
          await joinChannel(
            this.activeWriter,
            group.id,
            this.settings.senderId,
            this.settings.nickname,
          );
          for (const item of group.files) {
            const localItem = this.settings.sharedItems.find(
              (i) => i.id === item.id,
            );
            if (localItem) {
              const file = this.app.vault.getAbstractFileByPath(localItem.path);
              if (file instanceof TFile) {
                await this.syncHandler.startSync(file, false, false, true);
              }
            }
          }
        }
        await startHeartbeats(
          this,
          this.activeWriter,
          this.settings.channelName,
        );
      }
    } catch (e) {
      console.error("[OPV] Connection to server failed:", e);
      this.activeTransport = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      defaultSettings,
      (await this.loadData()) as PluginSettings,
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updatePresence(count: number) {
    if (!this.statusBarItem) return;

    if (count > 0) {
      this.statusBarItem.setText(`🟢 Online: ${count}`);
    } else {
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      this.statusBarItem.setText(`🔴 Offline`);
    }
  }

  onunload() {
    console.debug("[OPV] Unloading client...");
    void disconnect(this).then(() => {
      console.debug("[OPV] Disconnected from server.");
    });

    const preview = this.app.vault.getAbstractFileByPath("opv-preview.md");
    if (preview) {
      this.app.vault.adapter.remove("opv-preview.md").catch((e) => {
        console.error("[OPV] Failed to remove preview file:", e);
      });
    }

    this.app.workspace.getLeavesOfType(VIEW_TYPE_HISTORY).forEach((leaf) => {
      leaf.detach();
    });
  }
}

class vaultSettingsTab extends PluginSettingTab {
  plugin: OpVaultPlugin;

  constructor(app: App, plugin: OpVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Configuration").setHeading();

    new Setting(containerEl)
      .setName("Nickname")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("Your sender ID shown to other users.")
      .addText((text) =>
        text
          .setPlaceholder("Bob")
          .setValue(this.plugin.settings.nickname)
          .onChange(async (value) => {
            this.plugin.settings.nickname = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName("Server URL")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("The server address of the WebTransport server.")
      .addText((text) =>
        text
          // TODO: Change placeholder before release
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder("https://localhost:4433")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Global channel name")
      .setDesc("The default broadcast channel.")
      .addText((text) =>
        text
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder("vault-1")
          .setValue(this.plugin.settings.channelName)
          .onChange(async (value) => {
            this.plugin.settings.channelName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Inbox")
      .setDesc("Default path to store items.")
      .addText((text) => {
        const validate = (path: string) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          const isValid = file && file instanceof TFolder;
          text.inputEl.toggleClass("opv-resource-error-input", !isValid);
          text.inputEl.title = isValid ? "" : "Folder not found";
        };

        const saveAndValidate = async (value: string) => {
          this.plugin.settings.inboxPath = value;
          await this.plugin.saveSettings();
          validate(value);
        };

        const debounceUpdate = debounce(saveAndValidate, 500);

        text
          .setValue(this.plugin.settings.inboxPath)
          .onChange(async (value) => {
            debounceUpdate(value);
          });

        validate(this.plugin.settings.inboxPath);

        new FolderSelector(this.app, text.inputEl);
      });

    containerEl.createEl("hr");
    new Setting(containerEl).setName("Share groups").setHeading();

    const groupList = containerEl.createEl("div");

    if (this.plugin.settings.syncGroups.length === 0) {
      groupList.createEl("p", { text: "No sync groups created yet." });
    } else {
      this.plugin.settings.syncGroups.forEach((item, index) => {
        const itemDiv = groupList.createEl("div", { cls: "setting-item" });

        const infoDiv = itemDiv.createEl("div", { cls: "setting-item-info" });
        infoDiv.createEl("div", { text: item.id, cls: "setting-item-path" });

        const controlDiv = itemDiv.createEl("div", {
          cls: "setting-item-controls",
        });

        new Setting(controlDiv).addButton((btn) =>
          btn
            .setIcon("link")
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setTooltip("Copy share ID")
            .onClick(async () => {
              await navigator.clipboard.writeText(item.id);
              // eslint-disable-next-line obsidianmd/ui/sentence-case
              new Notice("Share ID copied to clipboard.");
            }),
        );

        new Setting(controlDiv).addButton((btn) =>
          btn
            .setButtonText("Stop sharing")
            .setWarning()
            .onClick(async () => {
              if (!this.plugin.activeTransport) {
                new Notice("Not connected to server.");
                console.debug("[OPV] No active transport found.");
                return;
              }
              new Notice(`Revoking share for group ${item.id}...`);
              console.debug(`[OPV] Revoking share for group ${item.id}...`);
              await this.plugin.syncHandler.removeSyncGroup(item);
              this.display();
            }),
        );
      });
    }

    containerEl.createEl("hr");
    new Setting(containerEl).setName("Shared items").setHeading();

    const shareList = containerEl.createEl("div");
    const items = this.plugin.settings.sharedItems.filter(
      (item) =>
        !this.plugin.settings.syncGroups.some((group) =>
          group.files.some((file) => file.path === item.path),
        ),
    );

    if (items.length === 0) {
      shareList.createEl("p", { text: "No items are currently shared." });
    } else {
      items.forEach((item, index) => {
        const itemDiv = shareList.createEl("div", { cls: "setting-item" });

        const infoDiv = itemDiv.createEl("div", { cls: "setting-item-info" });
        infoDiv.createEl("div", { text: item.path, cls: "setting-item-path" });

        const controlDiv = itemDiv.createEl("div", {
          cls: "setting-item-controls",
        });

        new Setting(controlDiv).addButton((btn) =>
          btn
            .setIcon("link")
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setTooltip("Copy share ID")
            .onClick(async () => {
              await navigator.clipboard.writeText(item.id);
              // eslint-disable-next-line obsidianmd/ui/sentence-case
              new Notice("Share ID copied to clipboard.");
            }),
        );

        new Setting(controlDiv).addButton((btn) =>
          btn
            .setButtonText("Stop sharing")
            .setWarning()
            .onClick(async () => {
              if (!this.plugin.activeTransport) {
                new Notice("Not connected to server.");
                console.debug("[OPV] No active transport found.");
                return;
              }
              new Notice(`Revoking share for ${item.path}...`);
              console.debug(`[OPV] Revoking share for ${item.path}...`);
              await remove(this.plugin, item.id);
              if (!this.plugin.activeWriter)
                return new Notice("Could not complete action.");
              await leaveChannel(
                this.plugin.activeWriter,
                item.id,
                this.plugin.settings.senderId,
              );
              const actualIndex = this.plugin.settings.sharedItems.findIndex(
                (i) => i.id === item.id,
              );
              if (actualIndex !== -1) {
                this.plugin.settings.sharedItems.splice(actualIndex, 1);
              }
              await this.plugin.saveSettings();
              this.display();
            }),
        );
      });
    }

    containerEl.createEl("hr");
    new Setting(containerEl).setName("Development").setHeading();

    new Setting(containerEl)
      .setName("Development mode")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.devMode)
        .onChange(async (value) => {
          if (value) {
            const response: boolean = await ConfirmModal.display(this.app, "Enable developer mode?", "Only enable developer if you know what you're doing. This creates areas for vulnerabilities.", true);
            console.debug(response);
            if (response) {
              this.plugin.settings.devMode = value;
              await this.plugin.saveSettings();
              this.display();
            } else {
              toggle.setValue(false);
            }
          } else {
            this.plugin.settings.devMode = value;
            await this.plugin.saveSettings();
            this.display();
          }
          new Notice("Please reload the app to apply changes.")
        })
      )

    if (this.plugin.settings.devMode) {
      new Setting(containerEl)
        .setName("Certificate hash")
        .addText((text) =>
          text
            .setPlaceholder("A certificate hash.")
            .setValue(this.plugin.settings.certHash)
            .onChange(async (value) => {
              this.plugin.settings.certHash = value;
              await this.plugin.saveSettings();
              this.display();
              new Notice("Please reload the app to apply changes.");
            })
        )
    }
  }
}
