import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import {
	connectToServer,
	upload,
	requestFile,
	remove,
	joinChannel,
} from "./transport";
import { sendFileChunked } from "./fileHandler";
import { SyncHandler } from "./syncHandler";
import type { SharedItem, PluginSettings, IOpVaultPlugin } from "./types";

export type { SharedItem };

const defaultSettings: PluginSettings = {
	serverUrl: "https://127.0.0.1:8080/ws",
	channelName: "vault-1",
	encryptionKey: "default",
	senderId: "",
	sharedItems: [],
};

function generateUUID(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
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
	settings: PluginSettings;
	activeWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	activeTransport: WebTransport | null = null;
	activeDownloads: Map<string, string> = new Map();
	heartbeatInterval: ReturnType<typeof setTimeout> | null = null;
	syncHandler: SyncHandler;
	statusBarItem: HTMLElement;
	onlineUsers: string[] = [];

	async onload() {
		console.debug("[OPV] Loading client...");
		await this.loadSettings();

		if (!this.settings.senderId) {
			this.settings.senderId = generateUUID();
			await this.saveSettings();
			console.debug(`[OPV] Generated new sender ID: ${this.settings.senderId}`);
		}

		this.syncHandler = new SyncHandler(this.app, this);

		this.addSettingTab(new vaultSettingsTab(this.app, this));

		this.statusBarItem = this.addStatusBarItem();
		this.updatePresence(0);
		this.statusBarItem.addClass("mod-clickable");
		this.statusBarItem.addEventListener("click", () => {
			if (this.onlineUsers.length > 0) {
				new Notice(`Online users:\n${this.onlineUsers.join("\n")}`);
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
				this.settings.senderId,
				this.settings.encryptionKey
			);
		});

		this.addRibbonIcon("link", "Share file", async () => {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("Open a file to share it!");
				console.debug("[OPV] Active file is not a TFile.");
				return;
			}

			new ShareModal(this.app, this, activeFile).open();
		});

		this.addRibbonIcon("download", "Download shared item", async () => {
			new DownloadModal(this.app, this).open();
		});

		this.registerEvent(
			this.app.workspace.on("file-open", async (file) => {
				if (!file) return;

				const shared = this.settings.sharedItems.some(
					(item) => item.path === file.path
				);

				if (shared) {
					console.debug(`[OPV] File opened is shared: ${file.path}`);
					await this.syncHandler.startSync(file);
				} else {
					console.debug(`[OPV] File opened is not shared: ${file.path}`);
				}
			})
		);
		await this.tryConnect();
	}

	async tryConnect() {
		if (this.activeTransport) {
			console.debug("[OPV] Already connected to server.");
			return;
		}
		try {
			this.activeTransport = await connectToServer(
				this.settings.serverUrl,
				this.settings.channelName,
				this
			);

			if (this.activeWriter) {
				console.debug("[OPV] Rejoining share channels.");
				for (const item of this.settings.sharedItems) {
					await joinChannel(this.activeWriter, item.id, this.settings.senderId);
				}
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
			(await this.loadData()) as PluginSettings
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
		console.debug("[OPV] We're done here... Bye bye :)");
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
					})
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
					})
			);

		containerEl.createEl("hr");
		new Setting(containerEl).setName("Shared items").setHeading();

		const shareList = containerEl.createEl("div");

		if (this.plugin.settings.sharedItems.length === 0) {
			shareList.createEl("p", { text: "No items are currently shared." });
		} else {
			this.plugin.settings.sharedItems.forEach((item, index) => {
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
						})
				);

				new Setting(controlDiv).addButton((btn) =>
					btn
						.setButtonText("Revoke")
						.setWarning()
						.onClick(async () => {
							if (!this.plugin.activeTransport) {
								new Notice("Not connected to server.");
								console.debug("[OPV] No active transport found.");
								return;
							}
							new Notice(`Revoking share for ${item.path}...`);
							console.debug(`[OPV] Revoking share for ${item.path}...`);
							await remove(this.plugin.activeTransport, item.id);
							this.plugin.settings.sharedItems.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);
			});
		}
	}
}

export class ShareModal extends Modal {
	plugin: OpVaultPlugin;
	file: TFile;
	pin: string = "";
	upload: boolean = false;

	constructor(app: App, plugin: OpVaultPlugin, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: `Share ${this.file.name}` });

		new Setting(contentEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("PIN (optional)")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Set a PIN to protect access to this shared item.")
			.addText((text) =>
				text.setPlaceholder("1234").onChange((value) => {
					this.pin = value;
				})
			);

		// new Setting(contentEl)
		// 	.setName("Upload to cloud")
		// 	.setDesc("Store offline and offsite.")
		// 	.addToggle((toggle) => toggle.onChange((v) => (this.upload = v)));
		this.upload = true;

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText("Create share")
				.setCta()
				.onClick(async () => {
					await this.createShare();
					this.close();
				});
		});
	}

	async createShare() {
		const shareId = generateUUID();
		const key = this.pin ? this.pin : "";
		const newShare: SharedItem = {
			id: shareId,
			path: this.file.path,
			pin: this.pin ? this.pin : undefined,
			key: key,
			createdAt: Date.now(),
			shares: 0,
		};

		if (!this.plugin.activeTransport) {
			new Notice("Not connected to server.");
			console.debug("[OPV] No active transport found.");
			return;
		}

		if (this.upload) {
			await upload(this, shareId, newShare.key);
		}

		this.plugin.settings.sharedItems.push(newShare);
		await this.plugin.saveSettings();
		await joinChannel(
			this.plugin.activeWriter,
			newShare.id,
			this.plugin.settings.senderId
		);

		console.debug(`joined channel ${newShare.id} after sharing`);

		await navigator.clipboard.writeText(shareId);
		if (this.pin) {
			new Notice(
				`Shared ${this.file.name}. The PIN has been copied to your clipboard.`
			);
		} else {
			new Notice(
				`Shared ${this.file.name}. No PIN was provided, so the ShareID has been copied to your clipboard.`
			);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class DownloadModal extends Modal {
	plugin: OpVaultPlugin;
	shareId: string;
	pin: string = "";

	constructor(app: App, plugin: OpVaultPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: `Download shared item` });

		new Setting(contentEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("Share ID")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Enter the share ID provided to you.")
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("xxxxxxxx-xxxx-xxxxx-xxxx-xxxxxxxxxxxx")
					.onChange((value) => {
						this.shareId = value;
					})
			);

		new Setting(contentEl)
			.setName("PIN")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Enter the PIN if you were provided one.")
			.addText((text) =>
				text.setPlaceholder("1234").onChange((value) => {
					this.pin = value;
				})
			);

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText("Download")
				.setCta()
				.onClick(async () => {
					await this.startDownload();
					this.close();
				});
		});
	}

	async startDownload() {
		if (!this.shareId) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Please enter a valid share ID.");
			console.error("[OPV] No Share ID provided.");
			return;
		}

		new Notice(`Starting download for Share ID: ${this.shareId}`);
		console.debug(`[OPV] Starting download for Share ID: ${this.shareId}`);

		this.plugin.activeDownloads.set(this.shareId, this.pin);
		await requestFile(this.shareId, this.plugin, this.pin);

		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
