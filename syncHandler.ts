import * as Y from "yjs";
import diff from "fast-diff";
import { App, TFile, Notice, MarkdownView, normalizePath } from "obsidian";
import { sendSecureMessage, sendRawJSON } from "./transport";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./crypto";
import { IOpVaultPlugin, TransportPacket, SharedItem } from "./types";

const openDocs = new Map<string, Y.Doc>();

export class SyncHandler {
	app: App;
	plugin: IOpVaultPlugin;
	isRemoteUpdate: boolean = false;

	saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(app: App, plugin: IOpVaultPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	async startSync(file: TFile) {
		if (openDocs.has(file.path)) return;

		const sharedItem = this.plugin.settings.sharedItems.find(
			(i) => i.path === file.path
		);
		if (!sharedItem) {
			console.error(`[OPV] No shared item found for path: ${file.path}`);
			return;
		}
		// const key = sharedItem ? (sharedItem.pin || sharedItem.key) : this.plugin.settings.encryptionKey;

		const doc = new Y.Doc();
		const yText = doc.getText("content");
		openDocs.set(file.path, doc);

		const stateLoaded = await this.loadYjsState(file, doc);

		if (!stateLoaded) {
			// Probably a new file
			const content = await this.app.vault.read(file);
			doc.transact(() => {
				yText.insert(0, content);
			}, "local-load");
			this.triggerSaveState(file, doc);
		} else {
			console.debug(`[OPV] Loaded Yjs state for file: ${file.path}`);
		}

		doc.on("update", (update: Uint8Array, origin: string) => {
			this.triggerSaveState(file, doc);

			if (origin === "remote" || origin === "local-load") return;

			void this.sendSyncMessage(file.path, "sync_update", update);
		});

		const stateVector = Y.encodeStateVector(doc);
		await this.sendSyncMessage(file.path, "sync_vector", stateVector);

		// Move this to the class (outside this function) in the future as a
		// listener for better performance
		this.plugin.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (!view.file) return;
				if (view.file && view.file.path === file.path) {
					this.handleLocalEdit(editor.getValue(), yText);
				}
			})
		);

		new Notice(`Sync started for ${file.name}`);
	}

	async loadYjsState(file: TFile, doc: Y.Doc): Promise<boolean> {
		const statePath: string = this.getStatePath(file);
		if (await this.app.vault.adapter.exists(statePath)) {
			const state = await this.app.vault.adapter.readBinary(statePath);
			Y.applyUpdate(doc, new Uint8Array(state));
			return true;
		} else {
			console.error(`[OPV] Failed to load Yjs State for ${file.path}`);
			return false;
		}
	}

	getStatePath(file: TFile): string {
		const prefix =
			(file.parent?.path || "") && (file.parent?.path || "") !== "/"
				? `${file.parent?.path || ""}/`
				: "";
		console.debug(file);
		return normalizePath(`${prefix}.${file.name}.yjs`);
	}

	triggerSaveState(file: TFile, doc: Y.Doc) {
		const path: string = file.path;
		if (this.saveTimers.has(path)) {
			clearTimeout(this.saveTimers.get(path));
		}

		const timer = setTimeout(() => {
			void (async () => {
				const state = Y.encodeStateAsUpdate(doc);
				const statePath = this.getStatePath(file);

				const folder = statePath.substring(0, statePath.lastIndexOf("/"));
				if (!(await this.app.vault.adapter.exists(folder))) {
					await this.app.vault.adapter.mkdir(folder);
				}

				await this.app.vault.adapter.writeBinary(
					statePath,
					state as unknown as ArrayBuffer
				);
				console.debug(`[OPV] Saved Yjs state for ${file.path}`);
			})();
		}, 2000);

		this.saveTimers.set(path, timer);
	}

	async handleSyncMessage(type: string, channelId: string, payload: string) {
		const sharedItem = this.plugin.settings.sharedItems.find(
			(i) => i.id === channelId
		);
		if (!sharedItem) {
			console.debug(`[OPV] No shared item for channel: ${channelId}, ignoring ${type}`);
			return;
		}

		const path = sharedItem.path;
		const doc = openDocs.get(path);
		if (!doc) {
			console.debug(`[OPV] No open doc for path: ${path}, ignoring ${type}`);
			return;
		}

		console.debug(`[OPV] Handling sync message: ${type} for ${path}`);
		const data: Uint8Array = new Uint8Array(base64ToArrayBuffer(payload));

		switch (type) {
			case "sync_vector": {
				const update = Y.encodeStateAsUpdate(doc, data);
				await this.sendSyncMessage(path, "sync_snapshot", update);
				break;
			}
			case "sync_snapshot":
			case "sync_update": {
				await this.applyUpdateToDoc(doc, data, path);
				break;
			}
		}
	}

	async applyUpdateToDoc(doc: Y.Doc, update: Uint8Array, path: string) {
		this.isRemoteUpdate = true;
		try {
			Y.applyUpdate(doc, update, "remote");
			console.debug(`[OPV] Applied Yjs update for ${path}`);

			const newContent = doc.getText("content").toJSON();

			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			let cursor = null;
			let editor = null;
			if (view && view.file && view.file.path === path) {
				editor = view.editor;
				cursor = editor.getCursor();
			}

			if (editor) {
				const currentContent = editor.getValue();
				if (currentContent === newContent) {
					console.debug(
						`[OPV] Content unchanged for ${path}, skipping editor update`
					);
				} else {
					console.debug(`[OPV] Updating editor content for ${path}`);
					editor.setValue(newContent);
					if (cursor) {
						const lineCount = editor.lineCount();
						let newLine = Math.min(cursor.line, lineCount - 1);
						if (newLine < 0) newLine = 0;
						const lineLength = editor.getLine(newLine).length;
						let newCh = Math.min(cursor.ch, lineLength);
						editor.setCursor({ line: newLine, ch: newCh });
					}
				}
			}

			// Always update the file on disk, even if editor is not open
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.app.vault.process(file, () => newContent);
				console.debug(`[OPV] Saved file to disk: ${path}`);
			}
		} catch (e) {
			console.error(`[OPV] Error applying update to ${path}:`, e);
		} finally {
			this.isRemoteUpdate = false;
		}
	}

	async sendSyncMessage(
		path: string,
		type: "sync_vector" | "sync_snapshot" | "sync_update",
		payload: Uint8Array
	) {
		const base64Payload = arrayBufferToBase64(payload.buffer as ArrayBuffer);
		if (!this.plugin.activeWriter) return;

		const sharedItem = this.plugin.settings.sharedItems.find(
			(i) => i.path === path
		);
		if (!sharedItem) {
			console.error(`[OPV] No shared item found for path: ${path}`);
			return;
		}

		await sendSecureMessage(
			this.plugin.activeWriter,
			sharedItem.id,
			this.plugin.settings.senderId,
			{
				type: type,
				path: path,
				syncPayload: base64Payload,
			},
			sharedItem.pin || ""
		);
	}

	handleLocalEdit(newContent: string, yText: Y.Text) {
		if (this.isRemoteUpdate) return;

		const currentContent = yText.toJSON();
		if (currentContent === newContent) return;

		const diffs = diff(currentContent, newContent);
		let index = 0;
		yText.doc?.transact(() => {
			for (const [type, text] of diffs) {
				switch (type) {
					case diff.EQUAL:
						index += text.length;
						break;
					case diff.INSERT:
						yText.insert(index, text);
						index += text.length;
						break;
					case diff.DELETE:
						yText.delete(index, text.length);
						break;
				}
			}
		}, "local");
	}

	async cleanup() {
		console.debug("[OPV] Cleaning up SyncHandler");
		for (const i of this.plugin.settings.sharedItems) {
			const packet: TransportPacket = {
				type: "leave",
				channel_id: i.id,
				sender_id: this.plugin.settings.senderId,
				payload: "bye bye!",
			};
			await sendRawJSON(this.plugin.activeWriter, packet);
			console.debug(`[OPV] Left transfer channel ${i.id}`);
		}

		for (const timer of this.saveTimers.values()) {
			clearTimeout(timer);
		}
		this.saveTimers.clear();

		for (const doc of openDocs.values()) {
			doc.destroy();
		}
		openDocs.clear();
		console.debug("[OPV] SyncHandler cleanup complete");
	}

	async handleRename(file: TFile, item: SharedItem) {
		const oldPath = item.path;
		const doc = openDocs.get(oldPath);
		if (doc) {
			openDocs.delete(oldPath);
			openDocs.set(file.path, doc);
		}

		if (this.saveTimers.has(oldPath)) {
			const timer = this.saveTimers.get(oldPath);
			if (timer) clearTimeout(timer);
			this.saveTimers.delete(oldPath);
		}

		const lastSlash = oldPath.lastIndexOf("/");
		const oldFolder = lastSlash !== -1 ? oldPath.substring(0, lastSlash) : "";
		const oldFilename = lastSlash !== -1 ? oldPath.substring(lastSlash + 1) : oldPath;
		const oldStatePath = normalizePath(`${oldFolder ? oldFolder + "/" : ""}.${oldFilename}.yjs`);
		const newStatePath = this.getStatePath(file);

		if (await this.app.vault.adapter.exists(oldStatePath)) {
			// No need to ensure directory exists as the new file is (hopefully) in that location
			await this.app.vault.adapter.rename(oldStatePath, newStatePath);
			console.debug(
				`[OPV] Renamed Yjs state file from ${oldStatePath} to ${newStatePath}`
			);
		}
	}
}
