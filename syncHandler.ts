import * as Y from "yjs";
import * as diff from "fast-diff";
import { App, TFile, Notice, MarkdownView, normalizePath } from "obsidian";
import { sendSecureMessage } from "./transport";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./crypto";
import { IOpVaultPlugin} from "./types";

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

    const sharedItem = this.plugin.settings.sharedItems.find(i => i.path === file.path);
    const key = sharedItem ? (sharedItem.pin || sharedItem.key) : this.plugin.settings.encryptionKey;

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

      void (async () => {
        const base64Update = arrayBufferToBase64(update.buffer as ArrayBuffer);
        if (this.plugin.activeWriter) {
          await sendSecureMessage(
            this.plugin.activeWriter,
            this.plugin.settings.channelName,
            this.plugin.settings.senderId,
            {
              type: "sync_update",
              path: file.path,
              syncPayload: base64Update,
            },
            key
          )
        }
      })();
    });

    const stateVector = Y.encodeStateVector(doc);
    await this.sendSyncMessage(file.path, "sync_vector", stateVector);

    this.plugin.registerEvent(
      this.app.workspace.on("editor-change", (editor, view) => {
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
    return normalizePath(`${file.path}.yjs`);
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

        await this.app.vault.adapter.writeBinary(statePath, state as unknown as ArrayBuffer);
        console.debug(`[OPV] Saved Yjs state for ${file.path}`);
      })();
    }, 2000);

    this.saveTimers.set(path, timer);
  }

  async handleSyncMessage(type: string, path: string, payload: string) {
    const doc = openDocs.get(path);
    if (!doc) return;

    const data: Uint8Array = new Uint8Array(base64ToArrayBuffer(payload));

    switch (type) {
      case "sync_vector":{
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

      const newContent = doc.getText("content").toJSON();

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view instanceof MarkdownView && view.file?.path === path) {
        const editor = view.editor;
        const cursor = editor.getCursor();
        if (editor.getValue() !== newContent) {
          editor.setValue(newContent);
          editor.setCursor(cursor);
        }
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.process(file, () => newContent);
      }
    } finally {
      this.isRemoteUpdate = false;
    }
  }

  async sendSyncMessage(path: string, type: "sync_vector" | "sync_snapshot" | "sync_update", payload: Uint8Array) {
    const base64Payload = arrayBufferToBase64(payload.buffer as ArrayBuffer);
    if (!this.plugin.activeWriter) return;

    const sharedItem = this.plugin.settings.sharedItems.find(i => i.path === path);
    if (!sharedItem) {
      console.error(`[OPV] No shared item found for path: ${path}`);
      return;
    }

    const key = sharedItem.pin || sharedItem.key;

    await sendSecureMessage(
      this.plugin.activeWriter,
      this.plugin.settings.channelName,
      this.plugin.settings.senderId,
      {
        type: type,
        path: path,
        syncPayload: base64Payload,
      },
      key,
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
}
