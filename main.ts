import {
	App,
	debounce,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
	TFile,
} from "obsidian";
import {
	connectToServer,
	upload,
	requestFile,
	remove,
	joinChannel,
	disconnect,
	sendSecureMessage,
	leaveChannel,
} from "./transport";
import { sendFileChunked } from "./fileHandler";
import { SyncHandler } from "./syncHandler";
import type {
	SharedItem,
	SyncGroup,
	PluginSettings,
	IOpVaultPlugin,
	InnerMessage,
} from "./types";
import { FolderSelector, ShareModal } from "./components";

export type { SharedItem };

const defaultSettings: PluginSettings = {
	serverUrl: "https://127.0.0.1:8080/ws",
	channelName: "vault-1",
	encryptionKey: "default",
	//TODO: Implement nicknames
	senderId: "",
	sharedItems: [],
	inboxPath: "",
	syncGroups: [],
};

export function generateUUID(): string {
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
			//* As part of the temporary UI overhaul, the user can now select the file(s)
			//* they want to share within the modal!
			// const activeFile = this.app.workspace.getActiveFile();
			// if (!activeFile) {
			// 	new Notice("Open a file to share it!");
			// 	console.debug("[OPV] Active file is not a TFile.");
			// 	return;
			// }

			new ShareModal(this.app, this).open();
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

		this.registerEvent(
			this.app.vault.on("rename", async (file, oldPath) => {
				if (!file || !(file instanceof TFile)) return;

				// Find the shared item by the old path (before rename)
				const sharedItem = this.settings.sharedItems.find(
					(item) => item.path === oldPath
				);
				if (!sharedItem) return;

				await this.syncHandler.handleRename(file, sharedItem);
				sharedItem.path = file.path;
				await this.saveSettings();
				console.debug(
					`[OPV] File moved or renamed: ${oldPath} -> ${file.path}`
				);
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
				for (const group of this.settings.syncGroups) {
					await joinChannel(
						this.activeWriter,
						group.id,
						this.settings.senderId
					);
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
		void disconnect(this).then(() => {
			console.debug("[OPV] We're done here... Bye bye :)");
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

		new Setting(containerEl)
			.setName("Inbox")
			.setDesc("Default path to store items.")
			.addText((text) => {
				const validate = (path: string) => {
					const file = this.app.vault.getAbstractFileByPath(path);
					const isValid = file && file instanceof TFolder;
					text.inputEl.toggleClass("folder-error-input", !isValid);
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
							new Notice(`Revoking share for group ${item.id}...`);
							console.debug(`[OPV] Revoking share for group ${item.id}...`);
							await this.plugin.syncHandler.removeSyncGroup(item);
							this.display();
						})
				);
			});
		}

		containerEl.createEl("hr");
		new Setting(containerEl).setName("Shared items").setHeading();

		const shareList = containerEl.createEl("div");
		const items = this.plugin.settings.sharedItems.filter(
			(item) =>
				!this.plugin.settings.syncGroups.some((group) =>
					group.files.some((file) => file.path === item.path)
				)
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
							const isOwner = item.owner === this.plugin.settings.senderId;
							if (isOwner) {
								new Notice(`Revoking share for ${item.path}...`);
								console.debug(`[OPV] Revoking share for ${item.path}...`);
								await remove(
									this.plugin.activeTransport,
									item.id,
									this.plugin.settings.senderId
								);
							} else {
								new Notice(`Removing ${item.path} from shared items...`);
								console.debug(
									`[OPV] Removing ${item.path} (not owner, won't delete from server)`
								);
							}
							await leaveChannel(
								this.plugin.activeWriter,
								item.id,
								this.plugin.settings.senderId
							);
							// Remove from the actual settings array, not the filtered copy
							const actualIndex = this.plugin.settings.sharedItems.findIndex(
								(i) => i.id === item.id
							);
							if (actualIndex !== -1) {
								this.plugin.settings.sharedItems.splice(actualIndex, 1);
							}
							await this.plugin.saveSettings();
							this.display();
						})
				);
			});
		}
	}
}

export class DownloadModal extends Modal {
	plugin: OpVaultPlugin;
	group?: string;
	shareId?: string;
	pin: string = "";
	mode: "file" | "group" = "file";

	constructor(app: App, plugin: OpVaultPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.display();
	}

	display() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Download shared item` });

		new Setting(contentEl)
			.setName("Share type")
			.setDesc("Share a single file or create a sync group?")
			.addDropdown((e) => {
				e.addOption("file", "Single file")
					.addOption("group", "Sync group")
					.setValue(this.mode)
					.onChange((value) => {
						this.mode = value as "file" | "group";
						this.display();
					});
			});

		contentEl.createEl("h3", { text: "Download details" });

		if (this.mode === "group") {
			new Setting(contentEl)
				.setName("Group name")
				.setDesc("Enter the group name provided to you.")
				.addText((text) =>
					text
						// eslint-disable-next-line obsidianmd/ui/sentence-case
						.setPlaceholder("share-group-1")
						.onChange((value) => {
							this.group = value;
						})
				);
		} else {
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
		}

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
				.setButtonText(this.mode === "file" ? "Get file" : "Get group")
				.setCta()
				.onClick(async () => {
					await this.startDownload();
					this.close();
				});
		});
	}

	async startDownload() {
		if (this.mode === "group") {
			this.plugin.activeDownloads.set(this.group, this.pin);
			const transportPacket: InnerMessage = {
				type: "get_group",
				content: this.group,
			};
			await joinChannel(
				this.plugin.activeWriter,
				this.group,
				this.plugin.settings.senderId
			);
			//TODO: Figure out how to handle collisions with the server (names)
			await sendSecureMessage(
				this.plugin.activeWriter,
				this.group,
				this.plugin.settings.senderId,
				transportPacket,
				this.pin
			);
			console.debug(`[OPV] Requested group info for group: ${this.group}`);
		} else {
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
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
