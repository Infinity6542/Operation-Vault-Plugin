import { App, TFile } from "obsidian";
import {
	IOpVaultPlugin,
	InnerMessage,
	ManifestItem,
	SyncMessage,
	TransportPacket,
} from "types";
import { sendSecureMessage } from "../networking";
import { receiveFile } from "../fileHandler";
import { arrayBufferToBase64 } from "../crypto";

export async function diffs(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	writer: WritableStreamDefaultWriter<Uint8Array>,
	key: string,
) {
	const app = plugin.app;
	if (!decrypted.content) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}
	console.debug(`[OPV] Sync diffs for file: ${decrypted.fileId}`);

	let remoteFiles: ManifestItem[] = [];
	try {
		remoteFiles = JSON.parse(decrypted.content) as ManifestItem[];
	} catch (e) {
		console.error("[OPV] Error parsing sync diffs payload", e);
		return;
	}

	const filesToRequest: string[] = [];
	for (const remote of remoteFiles) {
		const local = app.vault.getAbstractFileByPath(remote.path);
		if (!local || (local instanceof TFile && local.stat.mtime < remote.mtime)) {
			filesToRequest.push(remote.path);
		}
	}

	if (filesToRequest.length > 0) {
		const req: SyncMessage = {
			type: "changes",
			path: "request_batch",
			payload: JSON.stringify(filesToRequest),
		};
		await sendSecureMessage(
			writer,
			plugin.settings.channelName,
			plugin.settings.senderId,
			req,
			key,
		);
	}
}

export async function changes(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	writer: WritableStreamDefaultWriter<Uint8Array>,
	key: string,
) {
	const app = plugin.app;
	if (!decrypted.content) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}
	console.debug(`[OPV] Sync changes for file: ${decrypted.fileId}`);

	let requestedIds: string[] = [];
	try {
		requestedIds = JSON.parse(decrypted.content) as string[];
	} catch (e) {
		console.error("[OPV] Error parsing sync changes payload", e);
		return;
	}

	for (const path of requestedIds) {
		const file = app.vault.getAbstractFileByPath(path);

		if (file instanceof TFile) {
			const content = await app.vault.readBinary(file);
			const updateMessage: SyncMessage = {
				type: "update",
				path: path,
				payload: arrayBufferToBase64(content),
			};
			await sendSecureMessage(
				writer,
				plugin.settings.channelName,
				plugin.settings.senderId,
				updateMessage,
				key,
			);
		}
	}
}

export async function update(decrypted: InnerMessage, app: App) {
	if (!decrypted.content) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}
	console.debug(`[OPV] Sync update for file: ${decrypted.path}`);

	const path = decrypted.path;
	if (!path) {
		console.error("[OPV] update message missing path");
		return;
	}
	await receiveFile(app, path, decrypted.content, "", true);
}

export async function sync(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	message: TransportPacket,
) {
	if (decrypted.syncPayload) {
		await plugin.syncHandler.handleSyncMessage(
			decrypted.type,
			message.channel_id,
			decrypted.syncPayload,
		);
	}
	return;
}

export async function awareness(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	message: TransportPacket,
) {
	if (decrypted.path && decrypted.awarenessPayload) {
		let sharedItem = plugin.settings.sharedItems.find(
			(i) => i.id === message.channel_id,
		);
		if (!sharedItem) {
			console.error(
				"[OPV] Awareness message for unknown shared item:",
				message.channel_id,
			);
			return;
		}
		await plugin.syncHandler.handleAwarenessUpdate(
			sharedItem.path,
			decrypted.awarenessPayload,
		);
	} else {
		console.error("[OPV] Invalid awareness message:", decrypted);
	}
}
