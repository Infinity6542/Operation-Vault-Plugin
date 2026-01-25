import { App, TFile, Notice } from "obsidian";
import { IOpVaultPlugin, Manifest, SharedItem } from "types";
import { download } from "./comm";
import { decryptBinary } from "./crypto";

export function getFile(app: App, path: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

export function getDate(ms?: number): string {
	let now: Date;
	if (ms) {
		now = new Date(ms);
	} else {
		now = new Date();
	}
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export const sleep = (ms: number): Promise<void> => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};

export async function getManifest(
	plugin: IOpVaultPlugin,
	sharedItem: SharedItem,
): Promise<Manifest | undefined> {
	const buffer = await download(plugin, sharedItem.id, "manifest.json");
	if (!buffer) {
		console.error("[OPV] Failed to download manifest");
		new Notice("Failed to download manifest. Check console for details.");
		return;
	}

	const key =
		sharedItem.pin && sharedItem.pin.length > 0 ? sharedItem.pin : null;
	let manifestBuffer: Uint8Array | null = null;
	if (key) {
		manifestBuffer = await decryptBinary(buffer, key);
	} else {
		manifestBuffer = buffer;
	}

	if (!manifestBuffer) {
		console.error("[OPV] Failed to decrypt manifest");
		new Notice("Failed to decrypt manifest.");
		return;
	}

	const manifestJSON = new TextDecoder().decode(manifestBuffer);
	if (!manifestJSON) {
		console.warn(`[OPV] Empty manifest JSON for ${sharedItem.id}`);
		return;
	}
	const manifest = JSON.parse(manifestJSON) as Manifest;
	console.debug(`[OPV] Received manifest for ${sharedItem.id}:`, manifest);
	return manifest;
}
