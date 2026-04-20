import {
  ItemView,
  WorkspaceLeaf,
  Notice,
  ButtonComponent,
  TFile,
} from "obsidian";
import OpVaultPlugin from "./main";

export const VIEW_TYPE_HISTORY = "opv-history-view";

export class HistoryView extends ItemView {
  plugin: OpVaultPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: OpVaultPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_HISTORY;
  }

  getDisplayText(): string {
    return "Version history";
  }

  getIcon() {
    return "history";
  }

  onOpen(): Promise<void> {
    this.updateView();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void (() => this.updateView())();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("opv:snapshot-created", (shareId: string) => {
        void (() => {
          const file = this.app.workspace.getActiveFile();
          const currentItem = this.plugin.settings.sharedItems.find(
            (i) => i.path === file?.path,
          );
          if (currentItem && currentItem.id == shareId) {
            this.updateView();
          }
        })();
      }),
    );
    return Promise.resolve();
  }

  updateView() {
    const container = this.contentEl;
    container.empty();
    container.createEl("h3", { text: "Version history" });

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      container.createEl("p", { text: "No active file." });
      return;
    }

    const sharedItem = this.plugin.settings.sharedItems.find(
      (i) => i.path === file.path,
    );
    if (!sharedItem) {
      container.createEl("p", { text: "This file is not shared." });
      return;
    }

    const manifest = this.plugin.manifests.get(sharedItem.id);
    if (!manifest || manifest.snapshots.length === 0) {
      container.createEl("p", {
        text: "No version history is available at this time.",
      });
      return;
    }

    const list = container.createEl("div");
    [...manifest.snapshots].reverse().forEach((snapshot) => {
      const itemDiv = list.createEl("div", { cls: "opv-history-item" });
      const textDiv = itemDiv.createEl("div", { cls: "opv-history-text" });
      itemDiv.classList.add("opv-snapshot");
      textDiv.createEl("div", {
        text: `v${snapshot.iteration} - ${new Date(snapshot.ctime).toLocaleString()}`,
      });
      textDiv.createEl("small", {
        text: `Size: ${(snapshot.size / 1024).toFixed(2)} KB`,
      });

      const btnContainer = itemDiv.createEl("div", {
        cls: "opv-history-buttons",
      });
      new ButtonComponent(btnContainer)
        .setButtonText("Preview")
        .onClick(async () => {
          new Notice(`Retrieving version ${snapshot.iteration} for preview...`);
          const { contentBuffer } = await this.plugin.syncHandler.getSnapshot(
            sharedItem,
            snapshot.iteration,
          );
          if (!contentBuffer)
            return new Notice("Failed to retrieve snapshot content.");
          const previewPath = "opv-preview.md";
          await this.app.vault.adapter.write(
            previewPath,
            new TextDecoder().decode(contentBuffer),
          );
          const file = this.app.vault.getAbstractFileByPath(previewPath);
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf("split", "vertical");
            await leaf.openFile(file, { state: { mode: "preview" } });
            new Notice(`Previewing version ${snapshot.iteration} in new pane.`);
          } else {
            new Notice("Failed to create preview file.");
          }
        });
      new ButtonComponent(btnContainer)
        .setButtonText("Restore")
        .setClass("mod-warning")
        .onClick(async () => {
          new Notice(`Restoring version ${snapshot.iteration}...`);
          await this.plugin.syncHandler.restoreSnapshot(
            sharedItem,
            snapshot.iteration,
          );
        });
    });
  }
}
