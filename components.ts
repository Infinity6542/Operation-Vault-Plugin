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
} from "obsidian";
import {
	opError,
	FileMatch,
	FolderMatch,
	SyncGroup,
	SharedItem,
	UploadModal,
} from "./types";
// import syncHandler from "./syncHandler";
import OpVaultPlugin, { generateUUID } from "./main";
import { joinChannel, upload } from "./transport";

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

export class ShareModal extends Modal {
	mode: "file" | "group" = "file";
	plugin: OpVaultPlugin;
	pin: string = "";
	upload: boolean = true;
	item: string = "";
	activeFile: TFile;

	constructor(app: App, plugin: OpVaultPlugin, activeFile: TFile) {
		super(app);
		this.plugin = plugin;
		this.activeFile = activeFile;
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
						text.inputEl.toggleClass("resource-error-input", !isValid);
						text.inputEl.title = isValid ? "" : "File not found";
					};
					const saveAndValidate = async (value: string) => {
						this.item = value;
						await this.plugin.saveSettings();
						validate(value);
					};
					const debounceUpdate = debounce(saveAndValidate, 500);

					text.setPlaceholder("/path/to/file.md");
					text.setValue(this.activeFile ? this.activeFile.path : "");
					text.setValue(this.item).onChange(async (value) => {
						debounceUpdate(value);
					});

					validate(this.item);

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

		new Setting(contentEl)
			.setName("Upload to cloud")
			.setDesc("Store offline and offsite.")
			.addToggle((toggle) => toggle.onChange((v) => (this.upload = v)));

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText(
					this.mode === "file" ? "Create share" : "Create sync group",
				)
				.setCta()
				.onClick(async () => {
					if (this.mode === "file") {
						await this.createShare();
					} else {
						await this.createSyncGroup(this.item);
					}
					this.close();
				});
		});
	}

	async createShare() {
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
			const uploadObject: UploadModal = {
				file: file,
				app: this.app,
				plugin: this.plugin,
			};
			if (!this.plugin.activeTransport) {
				new Notice("Not connected to server.");
				console.debug("[OPV] No active transport found.");
				return;
			}
			if (this.upload) {
				await upload(uploadObject, newShare.id, newShare.key);
			}
			this.plugin.settings.sharedItems.push(newShare);
			await this.plugin.saveSettings();
			await joinChannel(
				this.plugin.activeWriter,
				newShare.id,
				this.plugin.settings.senderId,
			);
			console.debug(`joined channel ${newShare.id} after sharing`);
			await navigator.clipboard.writeText(newShare.id);
			new Notice(
				`Shared ${file.name}. The ShareID has been copied to your clipboard.`,
			);
		}
	}

	async createSyncGroup(id: string): Promise<void | opError> {
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
			let shareItem: SharedItem = this.plugin.settings.sharedItems.find(
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
			);
			index++;
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
		);
		console.debug(`[OPV] Joined channel ${id} after creating group`);
		group.id = id;
		if (!this.plugin.settings.syncGroups.find((g) => g.id === id)) {
			this.plugin.settings.syncGroups.push(group);
			await this.plugin.saveSettings();
		}
		await navigator.clipboard.writeText(id);
		new Notice(`Shared ${id}. The group ID has been copied to your clipboard.`);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
