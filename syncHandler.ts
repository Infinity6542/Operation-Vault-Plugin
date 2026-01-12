import * as Y from "yjs";
import { App, TFile, Notice } from "obsidian";
import { sendSecureMessage } from "./transport";
import {arrayBufferToBase64, base64ToArrayBuffer} from "./crypto";
import { IOpVaultPlugin } from "./types";

const openDocs = new Map<string, Y.Doc>();

export class SyncHandler {
  app: App;
  plugin: IOpVaultPlugin;

  constructor(app: App, plugin: IOpVaultPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  async startSync(file: TFile) {
    if (openDocs.has(file.path)) return; // Already syncing

    const doc = new Y.Doc();
    const yText = doc.getText("content");

    const content = await this.app.vault.read(file);
    doc.transact(() => {
      yText.insert(0, content);
    });

    openDocs.set(file.path, doc);

    console.debug(`Starting sync for ${file.path}`);

    doc.on("update", (update: Uint8Array) => {
      void (async () => {
        const base64Update = arrayBufferToBase64(update.buffer);

        if (this.plugin.activeWriter) {
          await sendSecureMessage(
            this.plugin.activeWriter,
            this.plugin.settings.channelName,
            this.plugin.settings.senderId,
            {
              type: "sync",
              path: file.path,
              syncPayload: base64Update,
            }
          );
        }
      })();
    });

    this.plugin.registerEvent(
      this.app.workspace.on("editor-change", (editor, view) => {
        if (view.file && view.file.path === file.path) {
          const content = editor.getValue();
          const yText = doc.getText("content");

          if (content !== yText.toJSON()) {
            doc.transact(() => {
              yText.delete(0, yText.length);
              yText.insert(0, content);
            });
          }
        }
      })
    );

    new Notice(`Sync started for ${file.path}`);
  }

  async applyUpdate(fileId: string, payload: string) {
    const doc = openDocs.get(fileId);
    if (!doc) {
      console.warn(`No Y.Doc found for fileId: ${fileId}`);
      return;
    }

    const update = new Uint8Array(base64ToArrayBuffer(payload));
    Y.applyUpdate(doc, update);
    console.debug(`Applied update to ${fileId}`);

    const yText = doc.getText("content");
    const newContent = yText.toJSON();

    const file = this.app.vault.getAbstractFileByPath(fileId);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, newContent).then(() => {
        console.debug(`File ${fileId} updated in vault.`);
      });
    }
  }
}
