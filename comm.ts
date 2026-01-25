import * as Y from "yjs";
import { Notice, TFile } from "obsidian";
import {
	arrayBufferToBase64,
	encryptBinary,
	decryptBinary,
	getHash,
} from "./crypto";
import { receiveFile } from "./fileHandler";
import type {
	IOpVaultPlugin,
	SharedItem,
	Manifest,
	Snapshot,
} from "./types";
import { getDate } from "./utils";

export async function upload(
	file: TFile,
	plugin: IOpVaultPlugin,
	shareId: string,
	pin?: string,
	manifest?: Manifest,
	snapshot?: Snapshot,
	yjsState?: Uint8Array,
) {
	const app = plugin.app;
	const transport = plugin.activeTransport;
	const fileData = await app.vault.readBinary(file);

	if (!snapshot) {
		snapshot = {
			iteration: 1,
			hash: "",
			size: file.stat.size,
			senderId: plugin.settings.senderId,
			ctime: Date.now(),
		};
	}

	const time = getDate(snapshot.ctime);

	if (!manifest) {
		manifest = {
			version: 1,
			owner: plugin.settings.senderId,
			updatedAt: Date.now(),
			updatedBy: plugin.settings.senderId,
			snapshots: [],
		};
	} else if (manifest.snapshots.length > 0) {
		snapshot.iteration =
			manifest.snapshots[manifest?.snapshots.length - 1].iteration + 1;
	}
	snapshot.hash = await getHash(fileData);
	snapshot.size = fileData.byteLength;
	plugin.manifests.set(shareId, manifest);
	manifest.snapshots.push(snapshot);
	if (!transport) return new Notice("No active connection.");

	try {
		new Notice(`Uploading file: ${file.name}`);

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		// reader is not used in upload
		// const reader = stream.readable.getReader();

		const name = time + "_" + snapshot.hash.slice(0, 8);
		const header =
			JSON.stringify({
				type: "upload",
				channel_id: shareId,
				payload: name,
				sender_id: plugin.settings.senderId,
			}) + "\n";
		const encoder = new TextEncoder();
		console.debug(`[OPV] Upload header: ${header}`);
		await writer.write(encoder.encode(header));

		const nameBytes = encoder.encode(file.name);

		const totalSize = 2 + nameBytes.length + fileData.byteLength;
		const packageBuffer = new Uint8Array(totalSize);

		packageBuffer[0] = nameBytes.length & 0xff;
		packageBuffer[1] = (nameBytes.length >> 8) & 0xff;
		packageBuffer.set(nameBytes, 2);
		packageBuffer.set(new Uint8Array(fileData), 2 + nameBytes.length);

		const key = pin && pin.length > 0 ? pin : null;
		let data: Uint8Array | null;
		if (key) {
			data = await encryptBinary(packageBuffer.buffer, key);
		} else {
			data = packageBuffer;
		}

		if (data) {
			await writer.write(data);
		}
		await writer.close();
	} catch (e) {
		console.error("[OPV] Error during file upload", e);
		new Notice("Error during file upload.");
	}
	try {
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const encoder = new TextEncoder();
		const key = pin && pin.length > 0 ? pin : null;

		const manifestHeader =
			JSON.stringify({
				type: "upload",
				channel_id: shareId,
				payload: "manifest.json",
				sender_id: plugin.settings.senderId,
			}) + "\n";
		console.debug(`[OPV] Manifest header: ${manifestHeader}`);
		await writer.write(encoder.encode(manifestHeader));

		let manifestData: Uint8Array | null;
		if (key) {
			manifestData = await encryptBinary(
				encoder.encode(JSON.stringify(manifest)).buffer,
				key,
			);
		} else {
			manifestData = encoder.encode(JSON.stringify(manifest));
		}

		if (manifestData) {
			await writer.write(manifestData);
		}
		await writer.close();

		new Notice(`Completed upload of file: ${file.name}`);
	} catch (e) {
		console.error("[OPV] Error during manifest upload", e);
		new Notice("Error during manifest upload.");
	}
	try {
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const encoder = new TextEncoder();
		const key = pin && pin.length > 0 ? pin : null;

		const path = plugin.syncHandler.getStatePath(file);
		const name = `${time}_${snapshot.hash.slice(0, 8)}.yjs`;
		let stateFile: ArrayBuffer;

		if (yjsState) {
			stateFile = yjsState.buffer as ArrayBuffer;
		} else if (path && (await app.vault.adapter.exists(path))) {
			stateFile = await app.vault.adapter.readBinary(path);
		} else {
			console.debug(
				`[OPV] No state file found for: ${file.path}, creating one.`,
			);
			const doc = new Y.Doc();
			const yText = doc.getText("content");
			yText.insert(0, new TextDecoder().decode(fileData));
			stateFile = Y.encodeStateAsUpdate(doc).buffer as ArrayBuffer;
		}
		const header =
			JSON.stringify({
				type: "upload",
				channel_id: shareId,
				payload: `${name}`,
				sender_id: plugin.settings.senderId,
			}) + "\n";
		console.debug(`[OPV] State header: ${header}`);
		await writer.write(encoder.encode(header));

		const buffer = new Uint8Array(stateFile);

		let data: Uint8Array | null;
		if (key) {
			data = await encryptBinary(buffer.buffer, key);
		} else {
			data = buffer;
		}

		if (data) {
			await writer.write(data);
		}
		await writer.close();

		new Notice(`Completed upload of file: ${file.name}`);
	} catch (e) {
		console.error("[OPV] Error during state file upload", e);
		new Notice("Error during state file upload.");
	}
}

export async function download(
	plugin: IOpVaultPlugin,
	shareId: string,
	resource: string,
): Promise<Uint8Array | undefined> {
	if (!plugin.activeTransport || !plugin.activeWriter) {
		console.error("[OPV] No active connection for download.");
		new Notice("Action could not be completed. Check console for details.");
		return;
	}
	const stream = await plugin.activeTransport.createBidirectionalStream();
	const writer =
		stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
	const reader =
		stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
	const encoder = new TextEncoder();

	const manifestHeader =
		JSON.stringify({
			type: "download",
			channel_id: shareId,
			payload: resource,
			sender_id: plugin.settings.senderId,
		}) + "\n";

	await writer.write(encoder.encode(manifestHeader));
	await writer.close();

	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			length += value.length;
		}
	}

	const buffer = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.length;
	}
	return buffer;
}

export async function getLatestSnapshot(
	plugin: IOpVaultPlugin,
	manifest: Manifest,
	key: string | null,
	shareId: string,
	overwrite: boolean = true,
) {
	plugin.manifests.set(shareId, manifest);
	console.debug(`[OPV] Received manifest for ${shareId}:`, manifest);
	const latest = manifest.snapshots[manifest.snapshots.length - 1];
	const snapshotBuffer = await download(
		plugin,
		shareId,
		`${getDate(latest.ctime)}_${latest.hash.slice(0, 8)}`,
	);

	let file: Uint8Array | null = null;
	if (snapshotBuffer) {
		if (key) {
			file = await decryptBinary(snapshotBuffer, key);
		} else {
			file = snapshotBuffer;
		}
	} else {
		console.error("[OPV] Invalid snapshot buffer type");
		new Notice("Action could not be completed. Check console for details.");
		return;
	}
	if (!file) {
		console.error("[OPV] Invalid snapshot data");
		new Notice("Action could not be completed. Check console for details.");
		return;
	}
	const nameLen = file[0] | (file[1] << 8);
	const nameBytes = file.slice(2, 2 + nameLen);
	const fileName = new TextDecoder().decode(nameBytes);
	const fileData = file.slice(2 + nameLen);

	const base64String = arrayBufferToBase64(fileData.buffer);

	let inboxPath = plugin.settings.inboxPath;
	const existingItem = plugin.settings.sharedItems.find(
		(i) => i.id === shareId,
	);

	if (overwrite && existingItem) {
		const fullPath = existingItem.path;
		const lastSlash = fullPath.lastIndexOf("/");
		if (lastSlash !== -1) {
			inboxPath = fullPath.substring(0, lastSlash);
		} else {
			inboxPath = "";
		}
	}

	const path = await receiveFile(
		plugin.app,
		fileName,
		base64String,
		inboxPath,
		overwrite,
	);

	if (!path) return console.warn(`[OPV] Failed to save/update file.`);

	const statePath = plugin.syncHandler.getStatePath(path);
	const pin =
		key || plugin.activeDownloads.get(shareId) || existingItem?.pin || "";

	const stateBuffer = await download(
		plugin,
		shareId,
		`${getDate(latest.ctime)}_${latest.hash.slice(0, 8)}.yjs`,
	);

	let state: Uint8Array | null = null;
	if (stateBuffer && pin) {
		state = await decryptBinary(stateBuffer, pin);
	} else if (stateBuffer && !pin) {
		state = stateBuffer;
	} else {
		console.debug(`[OPV] Invalid state buffer for ID: ${shareId}`);
		return;
	}
	if (state) {
		await plugin.app.vault.adapter.writeBinary(
			statePath,
			state.buffer as ArrayBuffer,
		);
		console.debug(
			`[OPV] Saved state file for downloaded file at: ${statePath}`,
		);
	}

	if (!plugin.settings.sharedItems.some((i) => i.id === shareId)) {
		const item: SharedItem = {
			id: shareId,
			path: path,
			pin: pin || "",
			key: key || "",
			createdAt: Date.now(),
			shares: 0,
		};

		plugin.settings.sharedItems.push(item);
		await plugin.saveSettings();
		console.debug(
			`[OPV] Added SharedItem for downloaded file: ${path} (ID: ${shareId})`,
		);
	} else {
		console.debug(`[OPV] Updated existing SharedItem file: ${path}`);
	}

	plugin.activeDownloads.delete(shareId);

	const cleanPath = path.startsWith("/") ? path.slice(1) : path;
	const tFile = plugin.app.vault.getAbstractFileByPath(cleanPath);

	console.debug(
		`[OPV] Starting sync for ${cleanPath}, TFile found: ${!!tFile}`,
	);

	if (tFile instanceof TFile) {
		await plugin.syncHandler.startSync(tFile);
	}
}

// TODO: Queue removals while offline
export async function remove(plugin: IOpVaultPlugin, shareId: string) {
	const transport = plugin.activeTransport;
	const senderId = plugin.settings.senderId;
	if (!transport) return new Notice("No active connection.");

	try {
		const encoder = new TextEncoder();
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		// In the future, read the response to make sure that the operation
		// was successful.
		// const reader = stream.readable.getReader();

		let shareItem = plugin.settings.sharedItems.find((i) => i.id === shareId);
		if (!shareItem) {
			return new Notice(`No shared item found with ID: ${shareId}`);
		}
		await plugin.app.vault.adapter.remove(
			plugin.syncHandler.getStatePath(shareItem.path),
		);

		const header =
			JSON.stringify({
				type: "remove",
				payload: shareId,
				sender_id: senderId,
			}) + "\n";
		await writer.write(encoder.encode(header));
		await writer.close();

		new Notice(`Delete request sent for item "${shareId}"`);
		console.debug(`[OPV] Delete request sent for item "${shareId}"`);
	} catch (e) {
		console.error("Error during delete request", e);
		new Notice(
			"Error during delete request. Check the console for more information.",
		);
	}
}