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
	sendSecureMessage,
	upload,
	download,
	remove,
  startSync,
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

function generateKey(): string {
	return (
		Math.random().toString(36).substring(2, 15) +
		Math.random().toString(36).substring(2, 15)
	);
}

export default class OpVaultPlugin extends Plugin implements IOpVaultPlugin {
	settings: PluginSettings;
	activeWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	activeTransport: WebTransport | null = null;
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

		this.addRibbonIcon("dice", "Test connection", async () => {
			const url = this.settings.serverUrl;
			const channel = this.settings.channelName;

			new Notice("Trying connection...");

			// activeWriter is defined when connectToServer is called
			// this.activeWriter = await connectToServer(url, channel, this.app, this);
			if (this.activeTransport) {
				new Notice("Looks like you're already connected!");
				console.error("[OPV] Already connected to server.");
				return;
			}
			this.activeTransport = await connectToServer(url, channel, this);
		});

		this.addRibbonIcon("text", "Chat", async () => {
			if (!this.activeWriter) {
				new Notice("Not connected to server.");
				console.debug("[OPV] No active writer found.");
				return;
			}
			new Notice("Broadcasting message...");
			await sendSecureMessage(
				this.activeWriter,
				this.settings.channelName,
				this.settings.senderId,
				{
					type: "chat",
					content: "Helloooooo!",
				},
        this.settings.encryptionKey
			);
			new Notice("Sent the message :)");
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
        this.settings.encryptionKey,
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

    this.addRibbonIcon("refresh-cw", "Sync file", async () => {
      await startSync(this);
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
			this.statusBarItem.setText(`🟢 Online: (${count})`);
		} else {
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
			.setName("Server URL")
			.setDesc("The server address of the WebTransport server.")
			.addText((text) =>
				text
					.setPlaceholder("https://localhost:4433")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Channel Name")
			.setDesc("The channel room ID to connect to.")
			.addText((text) =>
				text
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
						.setTooltip("Copy Share ID")
						.onClick(async () => {
							await navigator.clipboard.writeText(item.id);
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
			.setName("PIN (optional)")
			.setDesc("Set a PIN to protect access to this shared item.")
			.addText((text) =>
				text.setPlaceholder("1234").onChange((value) => {
					this.pin = value;
				})
			);

		new Setting(contentEl)
			.setName("Upload to cloud")
			.setDesc("Store offline and offsite.")
			.addToggle((toggle) => toggle.onChange((v) => (this.upload = v)));

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText("Create Share")
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

		if (this.upload) {
			if (!this.plugin.activeTransport) {
				new Notice("Not connected to server.");
				console.debug("[OPV] No active transport found.");
				return;
			}
			await upload(this, shareId, newShare.key);
		}

		this.plugin.settings.sharedItems.push(newShare);
		await this.plugin.saveSettings();

    await navigator.clipboard.writeText(shareId);
    if (this.pin) {
		  new Notice(`Shared ${this.file.name}. The PIN has been copied to your clipboard.`);
    } else {
      new Notice(`Shared ${this.file.name}. No PIN was provided, so the ShareID has been copied to your clipboard.`);
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
		contentEl.createEl("h2", { text: `Download Shared Item` });

		new Setting(contentEl)
			.setName("Share ID")
			.setDesc("Enter the Share ID provided to you.")
			.addText((text) =>
				text
					.setPlaceholder("xxxxxxxx-xxxx-xxxxx-xxxx-xxxxxxxxxxxx")
					.onChange((value) => {
						this.shareId = value;
					})
			);

		new Setting(contentEl)
			.setName("PIN")
			.setDesc("Enter the PIN if the shared item is protected.")
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
			new Notice("Please enter a valid Share ID.");
			console.error("[OPV] No Share ID provided.");
			return;
		}

		new Notice(`Starting download for Share ID: ${this.shareId}`);
		console.debug(`[OPV] Starting download for Share ID: ${this.shareId}`);

		if (!this.plugin.activeTransport) {
			new Notice("Not connected to server.");
			console.debug("[OPV] No active transport found.");
			return;
		}

		await download(this.shareId, this.app, this.plugin, this.pin);

		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
