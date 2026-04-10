import { TFile, Notice } from "obsidian";
import {
	IOpVaultPlugin,
	SharedItem,
	TransportPacket,
	InnerMessage,
	Manifest,
} from "../types";
import { arrayBufferToBase64, decryptBinary } from "../crypto";
import { sendSecureMessage, joinChannel } from "../networking";
import { receiveFile, conversion, sendFileChunked } from "../fileHandler";
import { download, getLatestSnapshot } from "../comm";

const incomingFiles = new Map<string, Uint8Array[]>();

export function handleFileIn(decrypted: InnerMessage) {
	if (!decrypted.fileId) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}
	switch (decrypted.type) {
		case "file_start": {
			incomingFiles.set(decrypted.fileId, []);
			console.debug(
				`Incoming file: ${decrypted.filename} (ID: ${decrypted.fileId})`,
			);
			break;
		}
		case "file_chunk": {
			if (
				!decrypted.fileId ||
				!incomingFiles.has(decrypted.fileId) ||
				!decrypted.content
			) {
				console.debug("[OPV] file_chunk message with unknown fileId");
				return;
			}

			const chunkBytes = conversion(decrypted.content);
			incomingFiles.get(decrypted.fileId)?.push(chunkBytes);
			console.debug(
				`[OPV] Received chunk ${decrypted.chunkIndex} for file ID: ${decrypted.fileId}`,
			);
		}
	}
}

export async function fileEnd(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	message: TransportPacket,
	key: string,
) {
	const app = plugin.app;
	if (!decrypted.fileId) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}
	if (!decrypted.filename || !incomingFiles.has(decrypted.fileId)) {
		console.debug("[OPV] Unknown inner message type:", decrypted);
		return;
	}
	const chunks = incomingFiles.get(decrypted.fileId);

	if (!chunks) {
		return;
	}

	const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
	const file = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		file.set(chunk, offset);
		offset += chunk.length;
	}

	const base64String = arrayBufferToBase64(file.buffer);

	const path = await receiveFile(
		app,
		decrypted.filename || "unnamed",
		base64String,
		plugin.settings.inboxPath,
	);
	incomingFiles.delete(decrypted.fileId);
	console.debug(
		`[OPV] Received file: ${decrypted.fileId} at path: ${path as string} at path: ${path as string}`,
	);

	if (
		path &&
		!plugin.settings.sharedItems.some((i) => i.id === message.channel_id)
	) {
		const pin = plugin.activeDownloads.get(message.channel_id) || "";

		const item: SharedItem = {
			id: message.channel_id,
			path: path,
			pin: pin || "",
			key: key,
			createdAt: Date.now(),
			shares: 0,
		};

		plugin.settings.sharedItems.push(item);
		await plugin.saveSettings();
		console.debug(
			`[OPV] Added SharedItem for downloaded file: ${path} (ID: ${message.channel_id})`,
		);
		console.debug(
			`[OPV] Added SharedItem for downloaded file: ${path} (ID: ${message.channel_id})`,
		);

		plugin.activeDownloads.delete(message.channel_id);

		const tFile = app.vault.getAbstractFileByPath(path);
		if (tFile instanceof TFile) {
			await plugin.syncHandler.startSync(tFile);
		}
	} else if (path) {
		console.debug(
			`[OPV] SharedItem already exists for channel: ${message.channel_id}`,
		);
	} else {
		console.warn(`[OPV] Failed to save file, path is: ${path as string}`);
	}
}

export async function downloadRequest(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	message: TransportPacket,
	writer: WritableStreamDefaultWriter<Uint8Array>,
) {
	console.debug(`[OPV] Download request for: ${decrypted.shareId}`);

	const app = plugin.app;
	const users = Array.from(
		plugin.channelUsers.get(message.channel_id) || [],
	).sort();
	let index = 0;
	if (users[0] === message.sender_id) {
		index = 1;
	}
	if (users.length <= 1 || users[index] !== plugin.settings.senderId) {
		console.debug(
			`[OPV] Ignoring download request due to not being the leader or the request was made in unusual circumstances.`,
		);
		return;
	}

	const shareItem = plugin.settings.sharedItems.find(
		(i: SharedItem) => i.id === decrypted.shareId,
	);

	if (!shareItem) {
		console.error(`[OPV] No shared item found for ID: ${decrypted.shareId}`);
		return;
	}

	const expectedPin = shareItem.pin || "";
	const incomingPin = decrypted.pin || "";

	if (expectedPin !== incomingPin) {
		console.error(
			`[OPV] Invalid pin for download request of share ID: ${decrypted.shareId}`,
		);
		return;
	}

	const fileToSend = app.vault.getAbstractFileByPath(shareItem.path);
	if (fileToSend instanceof TFile) {
		new Notice(`Sending shared file: ${fileToSend.basename}`);

		await sendFileChunked(
			writer,
			shareItem.id,
			fileToSend,
			app,
			plugin,
			shareItem.pin || "",
		);
		shareItem.shares++;
		void plugin.saveSettings();
	}
}

export async function requestFile(
	shareId: string,
	plugin: IOpVaultPlugin,
	pin?: string,
) {
	if (!plugin.activeWriter || !plugin.activeTransport) {
		new Notice("No active connection for download.");
		return;
	}

	console.debug(`[OPV] Requesting file with share ID: ${shareId}`);
	new Notice(`Requesting file...`);

	await joinChannel(
		plugin.activeWriter,
		shareId,
		plugin.settings.senderId,
		plugin.settings.nickname,
	);

	// Wait up to 3 seconds for the user list to arrive from the server
	let attempts = 0;
	while (plugin.channelUsers.get(shareId) === undefined && attempts < 30) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		attempts++;
	}

	if (
		plugin.channelUsers.has(shareId) &&
		plugin.channelUsers.get(shareId)!.size > 1
	) {
		console.debug(`[OPV] Fetching file from peers.`);
		await sendSecureMessage(
			plugin.activeWriter,
			shareId,
			plugin.settings.senderId,
			{
				type: "download_request",
				shareId: shareId,
				pin: pin || "",
			},
			pin || "",
		);
	} else {
		console.debug(`[OPV] Fetching file directly from cloud.`);
		const buffer = await download(plugin, shareId, "manifest.json");
		if (!buffer) {
			console.error("[OPV] Failed to download manifest");
			new Notice("Failed to download manifest. Check console for details.");
			return;
		}

		const key = pin && pin.length > 0 ? pin : null;
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

		const manifest = JSON.parse(
			new TextDecoder().decode(manifestBuffer),
		) as Manifest;
		await getLatestSnapshot(plugin, manifest, key, shareId);
	}
}
