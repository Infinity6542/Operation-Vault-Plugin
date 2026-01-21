import * as Y from "yjs";
import {
	Awareness,
	encodeAwarenessUpdate,
	applyAwarenessUpdate,
} from "y-protocols/awareness";
import {
	ViewPlugin,
	ViewUpdate,
	EditorView,
	Decoration,
	DecorationSet,
	WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import diff from "fast-diff";
import {
	App,
	Editor,
	EditorPosition,
	TFile,
	Notice,
	MarkdownView,
	normalizePath,
} from "obsidian";
import { sendSecureMessage, sendRawJSON, leaveChannel } from "./transport";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./crypto";
import {
	IOpVaultPlugin,
	TransportPacket,
	SharedItem,
	SyncGroup,
	opError,
	InnerMessage,
	AwarenessUpdate,
	RemoteCursor,
	AwarenessState,
} from "./types";
import { getFile } from "./utils";

const openDocs = new Map<string, Y.Doc>();
const openAwareness = new Map<string, Awareness>();

export class SyncHandler {
	app: App;
	plugin: IOpVaultPlugin;
	isRemoteUpdate: boolean = false;
	awaitingSnapshot = new Set<string>();

	saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(app: App, plugin: IOpVaultPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	async startSync(file: TFile, group?: boolean): Promise<SharedItem | void> {
		if (openDocs.has(file.path)) return;

		const sharedItem = this.plugin.settings.sharedItems.find(
			(i) => i.path === file.path,
		);
		if (!sharedItem) {
			console.error(`[OPV] No shared item found for path: ${file.path}`);
			return;
		}
		// const key = sharedItem ? (sharedItem.pin || sharedItem.key) : this.plugin.settings.encryptionKey;

		const doc = new Y.Doc();
		doc.clientID = this.hashString(this.plugin.settings.senderId);
		const yText = doc.getText("content");
		openDocs.set(file.path, doc);

		const awareness = new Awareness(doc);
		openAwareness.set(file.path, awareness);

		awareness.setLocalState({
			user: {
				name:
					this.plugin.onlineUsers.get(this.plugin.settings.senderId) ||
					"User " + this.plugin.settings.senderId.substring(0, 4),
				colour: stringToColour(this.plugin.settings.senderId),
				id: this.plugin.settings.senderId,
			},
		});

		awareness.on("update", (changes: AwarenessUpdate) => {
			const { added, updated, removed } = changes;
			const allChanges = added.concat(updated).concat(removed);
			if (allChanges.length > 0) {
				const update = encodeAwarenessUpdate(awareness, allChanges);
				void this.sendSyncMessage(file.path, "awareness", update);
			}
		});

		const stateLoaded = await this.loadYjsState(file, doc);

		// Always wait for a snapshot to prevent stale state duplication
		// unless we are sure we are alone (which we can't easily know yet)
		this.awaitingSnapshot.add(file.path);
		setTimeout(() => {
			if (this.awaitingSnapshot.has(file.path)) {
				console.debug(
					`[OPV] Snapshot timeout for ${file.path}, hydrating/resuming local edits`,
				);
				this.awaitingSnapshot.delete(file.path);
				// Force a check to catch up any edits made while waiting
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file && view.file.path === file.path) {
					this.handleLocalEdit(view.editor.getValue(), yText, file.path);
				}
			}
		}, 3000);

		if (!stateLoaded) {
			console.debug(
				`[OPV] No Yjs state found for ${file.path}, will initialize after sync`,
			);
			this.triggerSaveState(file, doc);
		} else {
			console.debug(`[OPV] Loaded Yjs state for file: ${file.path}`);
		}

		doc.on("update", (update: Uint8Array, origin: string) => {
			this.triggerSaveState(file, doc);

			if (origin === "remote" || origin === "local-load") return;

			void this.sendSyncMessage(file.path, "sync_update", update);
		});

		// Send state vector to request peer's state
		const stateVector = Y.encodeStateVector(doc);
		await this.sendSyncMessage(file.path, "sync_vector", stateVector);

		// Move this to the class (outside this function) in the future as a
		// listener for better performance
		this.plugin.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (!view.file) return;
				if (view.file && view.file.path === file.path) {
					this.handleLocalEdit(editor.getValue(), yText, file.path);
				}
			}),
		);

		new Notice(`Sync started for ${file.name}`);
		if (group) return sharedItem;
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

	async handleAwarenessUpdate(path: string, payload: string) {
		const awareness = openAwareness.get(path);
		if (!awareness) {
			console.error(`[OPV] No awareness found for path: ${path}`);
			return;
		}

		try {
			const update = new Uint8Array(base64ToArrayBuffer(payload));
			applyAwarenessUpdate(awareness, update, "remote");
			console.debug(`[OPV] Applied awareness update for ${path}`);
		} catch (e) {
			console.error(`[OPV] Error applying awareness update for ${path}:`, e);
		}
	}

	updateLocalCursor(editor: Editor, path: string) {
		const awareness = openAwareness.get(path);
		if (!awareness) return;

		const cursor: EditorPosition = editor.getCursor();

		const cursorState: RemoteCursor = {
			line: cursor.line,
			ch: cursor.ch,
		};

		awareness.setLocalStateField("cursor", cursorState);
	}

	hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash |= 0; // 32 bit
		}
		return Math.abs(hash);
	}

	getStatePath(file: TFile | string): string {
		const pathStr = typeof file === "string" ? file : file.path;
		const lastSlash = pathStr.lastIndexOf("/");
		const folder = lastSlash !== -1 ? pathStr.substring(0, lastSlash) : "";
		const filename =
			lastSlash !== -1 ? pathStr.substring(lastSlash + 1) : pathStr;
		return normalizePath(`${folder ? folder + "/" : ""}.${filename}.yjs`);
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
					state as unknown as ArrayBuffer,
				);
				console.debug(`[OPV] Saved Yjs state for ${file.path}`);
			})();
		}, 2000);

		this.saveTimers.set(path, timer);
	}

	async handleSyncMessage(type: string, channelId: string, payload: string) {
		const sharedItem = this.plugin.settings.sharedItems.find(
			(i) => i.id === channelId,
		);
		if (!sharedItem) {
			console.debug(
				`[OPV] No shared item for channel: ${channelId}, ignoring ${type}`,
			);
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
			case "sync_snapshot": {
				await this.applyUpdateToDoc(doc, data, path);
				this.awaitingSnapshot.delete(path);

				// After receiving initial snapshot, if doc is still empty, initialize from local file
				const yText = doc.getText("content");
				if (yText.length === 0) {
					console.debug(
						`[OPV] Document still empty after snapshot for ${path}`,
					);
					break;
				}
				const file = getFile(this.app, path);
				if (!file) {
					console.error(`[OPV] Could not find local file for path: ${path}`);
					break;
				}
				const content = await this.app.vault.read(file);
				if (content.length <= 0) {
					console.error(`[OPV] Local file is empty for path: ${path}`);
					break;
				}
				if (this.plugin.settings.senderId.localeCompare(sharedItem.id) < 0) {
					console.debug(
						`[OPV] Peer had no content, initializing from local file: ${path}`,
					);
					doc.transact(() => {
						yText.insert(0, content);
					}, "local");
					this.triggerSaveState(file, doc);
				} else {
					console.debug(
						`[OPV] Peer had no content, deferring initialization (tie-breaker)`,
					);
					// Wait for peer to initialize, or do it ourselves after timeout
					setTimeout(() => {
						if (yText.length === 0) {
							console.debug(
								`[OPV] Peer didn't initialize, doing it ourselves: ${path}`,
							);
							doc.transact(() => {
								yText.insert(0, content);
							}, "local");
							this.triggerSaveState(file, doc);
						}
					}, 2000);
				}
				break;
			}
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
						`[OPV] Content unchanged for ${path}, skipping editor update`,
					);
				} else {
					console.debug(`[OPV] Updating editor content for ${path}`);
					const scrollInfo = editor.getScrollInfo();
					editor.setValue(newContent);
					if (cursor) {
						const lineCount = editor.lineCount();
						let newLine = Math.min(cursor.line, lineCount - 1);
						if (newLine < 0) newLine = 0;
						const lineLength = editor.getLine(newLine).length;
						let newCh = Math.min(cursor.ch, lineLength);
						editor.setCursor({ line: newLine, ch: newCh });
					}
					editor.scrollTo(scrollInfo.left, scrollInfo.top);
				}
			}

			// Always update the file on disk, even if editor is not open
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const currentFileContent = await this.app.vault.read(file);
				if (currentFileContent !== newContent) {
					await this.app.vault.modify(file, newContent);
					console.debug(`[OPV] Saved file to disk: ${path}`);
				}
			}
		} catch (e) {
			console.error(`[OPV] Error applying update to ${path}:`, e);
		} finally {
			this.isRemoteUpdate = false;
		}
	}

	async sendSyncMessage(
		path: string,
		type: "sync_vector" | "sync_snapshot" | "sync_update" | "awareness",
		payload: Uint8Array,
	) {
		const base64Payload = arrayBufferToBase64(payload.buffer as ArrayBuffer);
		if (!this.plugin.activeWriter) return;

		const sharedItem = this.plugin.settings.sharedItems.find(
			(i) => i.path === path,
		);
		if (!sharedItem) {
			console.error(`[OPV] No shared item found for path: ${path}`);
			return;
		}

		const innerMessage: InnerMessage = {
			type: type,
			path: path,
		};

		if (type === "awareness") {
			innerMessage.awarenessPayload = base64Payload;
		} else {
			innerMessage.syncPayload = base64Payload;
		}

		await sendSecureMessage(
			this.plugin.activeWriter,
			sharedItem.id,
			this.plugin.settings.senderId,
			innerMessage,
			sharedItem.pin || "",
		);
	}

	handleLocalEdit(newContent: string, yText: Y.Text, path: string) {
		if (this.isRemoteUpdate) return;
		if (this.awaitingSnapshot.has(path)) {
			console.debug(
				`[OPV] Ignoring local edit for ${path} while awaiting snapshot`,
			);
			return;
		}

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
				nickname: this.plugin.settings.nickname,
				payload: "bye bye!",
			};
			if (!this.plugin.activeWriter) continue;
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
		if (oldPath === file.path) return;

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

		for (const aw of openAwareness.values()) {
			aw.destroy();
		}
		openAwareness.clear();

		const lastSlash = oldPath.lastIndexOf("/");
		const oldFolder = lastSlash !== -1 ? oldPath.substring(0, lastSlash) : "";
		const oldFilename =
			lastSlash !== -1 ? oldPath.substring(lastSlash + 1) : oldPath;
		const oldStatePath = normalizePath(
			`${oldFolder ? oldFolder + "/" : ""}.${oldFilename}.yjs`,
		);
		const newStatePath = this.getStatePath(file);

		if (oldStatePath === newStatePath) return;

		if (await this.app.vault.adapter.exists(oldStatePath)) {
			try {
				// If destination already exists, remove it first to avoid rename error
				if (await this.app.vault.adapter.exists(newStatePath)) {
					await this.app.vault.adapter.remove(newStatePath);
				}
				// No need to ensure directory exists as the new file is (hopefully) in that location
				await this.app.vault.adapter.rename(oldStatePath, newStatePath);
				console.debug(
					`[OPV] Renamed Yjs state file from ${oldStatePath} to ${newStatePath}`,
				);
			} catch (e) {
				console.error(`[OPV] Failed to rename Yjs state file:`, e);
			}
		}
	}
	async removeSyncGroup(group: SyncGroup): Promise<opError | void> {
		// Check for server connection
		if (!this.plugin.activeWriter || !this.plugin.activeTransport)
			return {
				code: -1,
				message:
					"activeWriter or activeTransport (or both) is null. This is likely due to the lack of a server connection.",
			};

		// Get files that are supposed to be in the group

		for (const sItem of group.files) {
			// Find the actual SharedItem in settings which has the correct local path
			const localItem = this.plugin.settings.sharedItems.find(
				(i) => i.id === sItem.id,
			);
			if (!localItem) {
				console.debug(`[OPV] Could not find SharedItem for ID ${sItem.id}`);
				continue;
			}

			const file = this.app.vault.getFileByPath(localItem.path);
			if (!file) {
				console.debug(`[OPV] Could not find file at path ${localItem.path}`);
				// Still remove from settings even if file doesn't exist
				this.plugin.settings.sharedItems =
					this.plugin.settings.sharedItems.filter((i) => i.id !== sItem.id);
				await this.plugin.saveSettings();
				group.files = group.files.filter((i) => i.id !== sItem.id);
				await leaveChannel(
					this.plugin.activeWriter,
					sItem.id,
					this.plugin.settings.senderId,
				);
				continue;
			}
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter: Record<string, unknown>) => {
					const current: unknown = frontmatter["sync-group"];
					if (!current) return;

					if (Array.isArray(current)) {
						const currentList = current as string[];
						const newList = currentList.filter((id) => id !== group.id);
						if (newList.length === 0) {
							delete frontmatter["sync-group"];
						} else {
							frontmatter["sync-group"] = newList;
						}
					} else if (typeof current === "string") {
						let values = current.split(",").map((s) => s.trim());
						if (values.includes(group.id)) {
							values = values.filter((id) => id !== group.id);
							if (values.length === 0) {
								delete frontmatter["sync-group"];
							} else {
								frontmatter["sync-group"] = values;
							}
						}
					}
				},
			);

			this.plugin.settings.sharedItems =
				this.plugin.settings.sharedItems.filter((i) => i.id !== sItem.id);
			await this.plugin.saveSettings();
			group.files = group.files.filter((i) => i.id !== sItem.id);
			await leaveChannel(
				this.plugin.activeWriter,
				sItem.id,
				this.plugin.settings.senderId,
			);
		}

		if (group.files.length > 0) {
			console.debug(
				`[OPV] Could not remove all files from sync group ${group.id}.`,
			);
		}

		this.plugin.settings.syncGroups = this.plugin.settings.syncGroups.filter(
			(g) => g.id !== group.id,
		);
		await this.plugin.saveSettings();
		new Notice(`Removed sync group ${group.id}.`);
	}
}

class CursorWidget extends WidgetType {
	constructor(
		readonly colour: string,
		readonly name: string,
	) {
		super();
	}

	toDOM() {
		const span = document.createElement("span");
		span.className = "opv-remote-label";
		span.style.backgroundColor = this.colour;
		span.textContent = this.name;
		return span;
	}

	eq(other: CursorWidget) {
		return this.colour === other.colour && this.name === other.name;
	}
}

class CaretWidget extends WidgetType {
	constructor(readonly colour: string) {
		super();
	}

	toDOM() {
		const span = document.createElement("span");
		span.className = "opv-remote-caret";
		span.style.borderLeft = `2px solid ${this.colour}`;
		return span;
	}

	eq(other: CaretWidget) {
		return this.colour === other.colour;
	}
}

export const cursorPlugin = (app: App) =>
	ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			awareness: Awareness | undefined;
			unsubscribe: () => void;
			refresh: boolean;

			constructor(view: EditorView) {
				this.decorations = Decoration.none;
				this.refresh = true;
				this.findAwareness(view);
			}

			findAwareness(view: EditorView) {
				const leaf = app.workspace.getLeavesOfType("markdown").find(
					// @ts-expect-error, not typed
					(l) => ((l.view as MarkdownView).editor?.cm as EditorView) === view,
				);

				if (leaf) {
					const file = (leaf.view as MarkdownView).file;
					if (file && openAwareness.has(file.path)) {
						this.awareness = openAwareness.get(file.path);

						const handler = ({
							added,
							updated,
							removed,
						}: {
							added: number[];
							updated: number[];
							removed: number[];
						}) => {
							const clientID = this.awareness?.clientID;
							const changes = [...added, ...updated, ...removed].filter(
								(id) => id !== clientID,
							);

							if (changes.length > 0) {
								this.refresh = true;
								view.dispatch();
							}
						};
						this.awareness?.on("change", handler);
						this.unsubscribe = () => {
							this.awareness?.off("change", handler);
						};
					}
				}
			}

			update(update: ViewUpdate) {
				if (!this.awareness) {
					this.findAwareness(update.view);
				}

				if (this.awareness && update.selectionSet) {
					const selection = update.view.state.selection.main;
					const doc = update.state.doc;
					const anchorline = doc.lineAt(selection.anchor);
					const headLine = doc.lineAt(selection.head);

					const anchor = {
						line: anchorline.number - 1,
						ch: selection.anchor - anchorline.from,
					};

					const head = {
						line: headLine.number - 1,
						ch: selection.head - headLine.from,
					};

					this.awareness.setLocalStateField("cursor", head);
					this.awareness.setLocalStateField("selection", { anchor, head });
				}

				this.decorations = this.decorations.map(update.changes);

				if (this.refresh && !update.docChanged) {
					this.decorations = this.buildDecorations(update.view);
					this.refresh = false;
				}

				if (
					update.docChanged ||
					update.viewportChanged ||
					update.transactions
				) {
					requestAnimationFrame(() => this.adjustLabels(update.view));
				}
			}

			adjustLabels(view: EditorView) {
				const labels = view.dom.querySelectorAll(".opv-remote-label");
				if (labels.length === 0) return;

				const editorRect = view.dom.getBoundingClientRect();
				const threshold = Math.min(editorRect.width * 0.2, 100);

				labels.forEach((el) => {
					const label = el as HTMLElement;
					const rect = label.getBoundingClientRect();
					const isFlipped = label.classList.contains("flipped");
					const anchorX = isFlipped ? rect.right : rect.left;
					const distanceFromRight = editorRect.right - anchorX;

					if (distanceFromRight < threshold) {
						if (!isFlipped) {
							label.classList.add("opv-align-right");
						}
					} else {
						if (isFlipped) {
							label.classList.remove("opv-align-right");
						}
					}
				});
			}

			destroy() {
				if (this.unsubscribe) this.unsubscribe();
			}

			buildDecorations(view: EditorView): DecorationSet {
				if (!this.awareness) return Decoration.none;

				const builder = new RangeSetBuilder<Decoration>();
				const states = this.awareness.getStates();
				const clientID = this.awareness.clientID;
				const items: {
					from: number;
					to: number;
					decoration: Decoration;
				}[] = [];

				states.forEach((state, id) => {
					const remoteState = state as AwarenessState;
					if (
						id === clientID ||
						!state.cursor ||
						!state.user ||
						!remoteState.cursor ||
						!remoteState.user
					)
						return;

					const line = Math.min(
						remoteState.cursor.line,
						view.state.doc.lines - 1,
					);
					if (line < 0) return;

					if (remoteState.selection) {
						const { anchor, head } = remoteState.selection;
						const maxLine = view.state.doc.lines - 1;
						const aLine = Math.min(anchor.line, maxLine);
						const hLine = Math.min(head.line, maxLine);

						if (aLine >= 0 && hLine >= 0) {
							const aLineObj = view.state.doc.line(aLine + 1);
							const hLineObj = view.state.doc.line(hLine + 1);
							const aPos = Math.min(aLineObj.from + anchor.ch, aLineObj.to);
							const hPos = Math.min(hLineObj.from + head.ch, hLineObj.to);
							const from = Math.min(aPos, hPos);
							const to = Math.max(aPos, hPos);

							if (from !== to) {
								items.push({
									from,
									to,
									decoration: Decoration.mark({
										attributes: {
											style: `background-color: ${toTransparent(remoteState.user.colour, 0.3)};`,
										},
										class: "opv-remote-selection",
									}),
								});
							}
						}
					}

					if (remoteState.cursor) {
						const maxLine = view.state.doc.lines - 1;
						const line = Math.min(remoteState.cursor.line, maxLine);

						if (line >= 0) {
							const lineObj = view.state.doc.line(line + 1);
							const ch = Math.min(remoteState.cursor.ch, lineObj.length);
							const pos = lineObj.from + ch;

							items.push({
								from: pos,
								to: pos,
								decoration: Decoration.widget({
									widget: new CursorWidget(
										remoteState.user.colour,
										remoteState.user.name,
									),
									side: 1,
								}),
							});

							items.push({
								from: pos,
								to: pos,
								decoration: Decoration.widget({
									widget: new CaretWidget(remoteState.user.colour),
									side: 0,
								}),
							});
						}
					}
				});

				items.sort((a, b) => {
					if (a.from !== b.from) return a.from - b.from;

					return a.decoration.startSide - b.decoration.startSide;
				});

				for (const item of items) {
					builder.add(item.from, item.to, item.decoration);
				}

				return builder.finish();
			}
		},
		{
			decorations: (v) => v.decorations,
		},
	);

// Flagged as candidate to be moved to utils.ts in future refactor
function stringToColour(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	const h = Math.abs(hash) % 360;
	const s = 75;
	const l = 35;

	return `hsl(${h}, ${s}%, ${l}%)`;
}

function toTransparent(hsl: string, alpha: number): string {
	if (hsl.startsWith("hsl")) {
		return hsl.replace("hsl", "hsla").replace(")", `, ${alpha})`);
	}
	return hsl;
}
