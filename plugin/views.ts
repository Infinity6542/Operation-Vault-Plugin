import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	ButtonComponent,
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

	async onOpen() {
		await this.updateView();
		this.registerEvent(
			this.app.workspace.on(
				"active-leaf-change",
				async () => await this.updateView(),
			),
		);
	}

	async updateView() {
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
			itemDiv.classList.add("opv-snapshot");
			itemDiv.createEl("div", {
				text: `v${snapshot.iteration} - ${new Date(snapshot.ctime).toLocaleString()}`,
			});
			itemDiv.createEl("small", {
				text: `Size: ${(snapshot.size / 1024).toFixed(2)} KB`,
			});

			const btnContainer = itemDiv.createEl("div", {
				cls: "opv-history-buttons",
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
