import {
	AbstractInputSuggest,
	App,
	debounce,
	prepareFuzzySearch,
	renderMatches,
	Modal,
	Notice,
	TFile,
	Setting,
    ButtonComponent,
    // stringifyYaml,
} from "obsidian";
import {
	opError,
	FileMatch,
	FolderMatch,
	SyncGroup,
	SharedItem,
	InnerMessage,
} from "./types";
import OpVaultPlugin, { generateUUID } from "./main";
import {
	requestFile,
} from "./handlers/fileTransfer";
import { upload } from "./comm";
import { sendSecureMessage, joinChannel } from "./networking";

//TODO: Remake the UI, particularly tracking shares
// Differentiate between shares and receives

export class FolderSelector extends AbstractInputSuggest<FolderMatch> {
	inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	getSuggestions(query: string): FolderMatch[] {
		const searchFn = prepareFuzzySearch(query);
		const folders = this.app.vault.getAllFolders(true);
		const results: FolderMatch[] = [];

		for (const folder of folders) {
			const match = searchFn(folder.path);
			if (match) {
				results.push({ item: folder, match });
			}
		}

		return results.sort((a, b) => b.match.score - a.match.score);
	}

	renderSuggestion(value: FolderMatch, el: HTMLElement): void {
		renderMatches(el, value.item.path, value.match.matches);
	}

	selectSuggestion(value: FolderMatch): void {
		this.inputEl.value = value.item.path;
		this.inputEl.trigger("input");
		this.close();
	}
}

export class FileSelector extends AbstractInputSuggest<FileMatch> {
	inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	getSuggestions(query: string): FileMatch[] {
		const searchFn = prepareFuzzySearch(query);
		const files = this.app.vault.getFiles();
		const results: FileMatch[] = [];

		for (const file of files) {
			const match = searchFn(file.path);
			if (match) {
				results.push({ item: file, match });
			}
		}

		return results.sort((a, b) => b.match.score - a.match.score);
	}

	renderSuggestion(value: FileMatch, el: HTMLElement): void {
		renderMatches(el, value.item.path, value.match.matches);
	}

	selectSuggestion(value: FileMatch): void {
		this.inputEl.value = value.item.path;
		this.inputEl.trigger("input");
		this.close();
	}
}

//TODO: Merge group and individual file sharing methods
// Do this by completely adopting the group and using the unique UUID from
// the old individual share as the group name/ID.
export class ShareModal extends Modal {
	mode: "file" | "group" = "file";
	plugin: OpVaultPlugin;
	pin: string = "";
	upload: boolean = true;
	item: string = "";
	activeFile: TFile | null;

	constructor(app: App, plugin: OpVaultPlugin, activeFile: TFile | null) {
		super(app);
		this.plugin = plugin;
		this.activeFile = activeFile ? activeFile : null;
	}

	onOpen() {
		this.display();
	}

	display() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: this.mode === "file" ? `Share a file` : `Create a share group`,
		});

		new Setting(contentEl)
			.setName("Share type")
			.setDesc("Share a single file or multiple?")
			.addDropdown((e) => {
				e.addOption("file", "Single file")
					.addOption("folder", "Sync group")
					.setValue(this.mode)
					.onChange((value) => {
						this.mode = value as "file" | "group";
						this.display();
					});
			});

		contentEl.createEl("h3", { text: "Share details" });

		if (this.mode === "file") {
			new Setting(contentEl)
				.setName("File")
				.setDesc("Select a file to share.")
				.addText((text) => {
					const validate = (path: string) => {
						const file = this.app.vault.getAbstractFileByPath(path);
						const isValid = file && file instanceof TFile;
						text.inputEl.toggleClass("opv-resource-error-input", !isValid);
						text.inputEl.title = isValid ? "" : "File not found";
					};
					const saveAndValidate = async (value: string) => {
						this.item = value;
						await this.plugin.saveSettings();
						validate(value);
					};
					const debounceUpdate = debounce(saveAndValidate, 500);

					const value = this.activeFile ? this.activeFile.path : "";
					this.item = value;

					text.setPlaceholder("/path/to/file.md")
						.setValue(value)
						.onChange(async (value) => {
							debounceUpdate(value);
						});

					validate(value);

					new FileSelector(this.app, text.inputEl);
				});
		} else {
			new Setting(contentEl)
				.setName("Group name")
				.setDesc("Name for your group of files")
				.setTooltip("Comma-separated value in frontmatter 'sync-group'.")
				.addText((text) =>
					text.setValue(this.item).onChange(async (value) => {
						this.item = value;
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(contentEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("PIN (optional)")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Set up a PIN to protect access")
			.setTooltip(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"Setting up a PIN will require it to access the shared item. Don't lose it! It won't be shown again.",
			)
			.addText((text) =>
				text.setPlaceholder("1234").onChange((value) => {
					this.pin = value;
				}),
			);

		// Force upload
		// new Setting(contentEl)
		// 	.setName("Upload to cloud")
		// 	.setDesc("Store offline and offsite.")
		// 	.addToggle((toggle) => toggle.onChange((v) => (this.upload = v)));

		let final = new Setting(contentEl);
		final.addButton((btn) => {
			btn
				.setButtonText(
					this.mode === "file" ? "Create share link" : "Create group link",
				)
				.setCta()
				.onClick(async () => {
					let id;
					if (this.mode === "file") {
						id = await this.createShare();
					} else {
						id = await this.createSyncGroup(this.item);
					}
					if (!(id && typeof id === "string"))
						return new Notice("Failed to create share.");
					const link = `obsidian://opv?action=join&id=${id}`;
					await navigator.clipboard.writeText(link);
					new Notice(
						`Shared ${id}. The ${
							this.mode === "file" ? "share ID" : "group ID"
						} has been copied to your clipboard.`,
					);
					this.close();
				});
		});
		final.addButton((btn) => {
			btn
				.setButtonText(
					this.mode === "file" ? "Create share" : "Create sync group",
				)
				.setCta()
				.onClick(async () => {
					let id;
					if (this.mode === "file") {
						id = await this.createShare();
					} else {
						id = await this.createSyncGroup(this.item);
					}
					if (!(id && typeof id === "string"))
						return new Notice("Failed to create share.");
					await navigator.clipboard.writeText(id);
					new Notice(
						`Shared ${id}. The ${
							this.mode === "file" ? "share ID" : "group ID"
						} has been copied to your clipboard.`,
					);
					this.close();
				});
		});
	}

	async createShare(): Promise<void | string> {
		if (!this.plugin.activeTransport || !this.plugin.activeWriter) {
			new Notice("Not connected to server.");
			console.debug("[OPV] No active transport found.");
			return;
		}
		if (this.mode === "group") {
			await this.createSyncGroup(this.item);
		} else {
			const file = this.app.vault.getAbstractFileByPath(this.item);
			if (!(file instanceof TFile)) {
				new Notice("Invalid file selected.");
				console.debug("[OPV] Invalid file selected for sharing.");
				return;
			}
			const newShare: SharedItem = {
				id: generateUUID(),
				path: file.path,
				pin: this.pin ? this.pin : undefined,
				key: this.pin ? this.pin : "",
				createdAt: Date.now(),
				shares: 0,
			};
			if (this.upload) {
				await upload(file, this.plugin, newShare.id, newShare.key);
			}
			this.plugin.settings.sharedItems.push(newShare);
			await this.plugin.saveSettings();
			await joinChannel(
				this.plugin.activeWriter,
				newShare.id,
				this.plugin.settings.senderId,
				this.plugin.settings.nickname,
			);
			console.debug(`joined channel ${newShare.id} after sharing`);
			await this.plugin.syncHandler.startSync(file);
			return newShare.id;
		}
	}

	async createSyncGroup(id: string): Promise<void | string | opError> {
		const allFiles = this.app.vault.getFiles();
		const matches: TFile[] = [];
		const group: SyncGroup = {
			id: id,
			files: [],
		};
		// Check for server connection
		if (!this.plugin.activeWriter || !this.plugin.activeTransport)
			return {
				code: -1,
				message:
					"activeWriter or activeTransport (or both) is null. This is likely due to the lack of a server connection.",
			};

		// Get files that are supposed to be in the group
		for (const file of allFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.frontmatter) continue;

			let groups: unknown = cache.frontmatter?.["sync-group"];
			if (!groups) continue;

			if (Array.isArray(groups)) {
				if (groups.includes(id)) matches.push(file);
			} else if (typeof groups === "string") {
				const values = groups.split(",").map((s) => s.trim());
				if (values.includes(id)) matches.push(file);
			} else {
				console.debug(
					`Unhandled type for sync-group frontmatter in ${
						file.path
					}: ${typeof groups}`,
				);
			}
		}

		// Beginning syncing the files
		let index: number = 0;
		for (const file of matches) {
			let shareItem = this.plugin.settings.sharedItems.find(
				(item) => item.path === file.path,
			);
			//TODO: Consider if I should just make a new SharedItem for this entirely.
			if (!shareItem) {
				shareItem = {
					id: generateUUID(),
					path: file.path,
					pin: this.pin ? this.pin : undefined,
					key: this.pin ? this.pin : "",
					createdAt: Date.now(),
					shares: 0,
					groups: [id],
				};
				this.plugin.settings.sharedItems.push(shareItem);
			} else {
				if (!shareItem.groups) shareItem.groups = [];
				shareItem.groups.push(id);
			}
			await this.plugin.saveSettings();

			group.files.push(shareItem);
			await joinChannel(
				this.plugin.activeWriter,
				shareItem.id,
				this.plugin.settings.senderId,
				this.plugin.settings.nickname,
			);
			index++;
			await this.plugin.syncHandler.startSync(file);
		}
		if (index !== matches.length) {
			console.debug(
				`[OPV] Only synced ${index} out of ${matches.length} files for group ${id}.`,
			);
			new Notice(
				`Something went wrong while adding sync group ${id}. Check console for details.`,
			);
			return {
				code: -1,
				message: `Only synced ${index} out of ${matches.length} files for group ${id}.`,
			};
		}
		await joinChannel(
			this.plugin.activeWriter,
			id,
			this.plugin.settings.senderId,
			this.plugin.settings.nickname,
		);
		console.debug(`[OPV] Joined channel ${id} after creating group`);
		group.id = id;
		if (!this.plugin.settings.syncGroups.find((g) => g.id === id)) {
			this.plugin.settings.syncGroups.push(group);
			await this.plugin.saveSettings();
		}
		return id;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
export class DownloadModal extends Modal {
	plugin: OpVaultPlugin;
	group?: string;
	shareId?: string;
	pin: string = "";
	mode: "file" | "group" = "file";

	constructor(
		app: App,
		plugin: OpVaultPlugin,
		defaultId?: string,
		// defaultPin?: string,
	) {
		super(app);
		this.plugin = plugin;
		this.shareId = defaultId;
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
						}),
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
						.setValue(this.shareId ? this.shareId : "")
						.onChange((value) => {
							this.shareId = value;
						}),
				);
		}

		new Setting(contentEl)
			.setName("PIN")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Enter the PIN if you were provided one.")
			.addText((text) =>
				text.setPlaceholder("1234").onChange((value) => {
					this.pin = value;
				}),
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
			if (!this.group || !this.plugin.activeWriter) {
				new Notice("Could not complete action. Check console for details.");
				console.error("[OPV] No group name provided or no active writer.");
				return;
			}
			this.plugin.activeDownloads.set(this.group, this.pin);
			const transportPacket: InnerMessage = {
				type: "group_get",
				content: this.group,
			};
			await joinChannel(
				this.plugin.activeWriter,
				this.group,
				this.plugin.settings.senderId,
				this.plugin.settings.nickname,
			);
			//TODO: Figure out how to handle collisions with the server (group names)
			await sendSecureMessage(
				this.plugin.activeWriter,
				this.group,
				this.plugin.settings.senderId,
				transportPacket,
				this.pin,
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

export class ConfirmModal extends Modal {
  private resolve: (value: boolean) => void;
  private submitted: boolean = false;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private destructive?: boolean,
  ) {
    super(app);
  }

  static async display(app: App, title: string, message: string, destructive?: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(app, title, message, destructive);
      modal.resolve = resolve;
      modal.open();
    })
  }

  onOpen() {
    const { contentEl, titleEl } = this;

    titleEl.setText(this.title);
    contentEl.createEl("p", { text: this.message });

    const btnDiv = contentEl.createDiv({ cls: "opv-modal-btns" });

    if (this.destructive) {
      new ButtonComponent(btnDiv)
      .setButtonText("Confirm")
      .setWarning()
      .onClick(() => {
          this.submitted = true;
          this.resolve(true);
          this.close();
        });
    } else {
      new ButtonComponent(btnDiv)
      .setButtonText("Confirm")
      .setCta()
      .onClick(() => {
          this.submitted = true;
          this.resolve(true);
          this.close();
        })
    }

    new ButtonComponent(btnDiv)
    .setButtonText("Cancel")
    .onClick(() => {
        this.close();
      })
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) {
      this.resolve(false);
    }
  }
}

