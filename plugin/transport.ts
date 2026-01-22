import { Notice, App, TFile } from "obsidian";
import {
	encryptPacket,
	decryptPacket,
	arrayBufferToBase64,
	encryptBinary,
	decryptBinary,
	getHash,
} from "./crypto";
import { sendFileChunked, conversion, receiveFile } from "./fileHandler";
import type {
	IOpVaultPlugin,
	SharedItem,
	UploadModal,
	InnerMessage,
	TransportPacket,
	SyncMessage,
	ManifestItem,
	SyncGroup,
	Manifest,
	Snapshot,
} from "./types";
import { getDate } from "./utils";

const incomingFiles = new Map<string, Uint8Array[]>();
let noticeDebounce: ReturnType<typeof setTimeout> | null = null;

export async function connect(
	url: string,
	channelID: string,
	plugin: IOpVaultPlugin,
): Promise<WebTransport | null> {
	const senderId = plugin.settings.senderId;
	const app = plugin.app;
	const devHash = "jBP/DWl5hVbT1GazEAIFj9K5bL31UhyZaRQ35IYxKr4=";
	const options: WebTransportOptions = {
		serverCertificateHashes: [
			{
				algorithm: "sha-256",
				value: conversion(devHash).buffer as ArrayBuffer,
			},
		],
	};

	try {
		const transport = new WebTransport(url, options);

		console.debug("[OPV] Attempting a connection to " + url);
		await transport.ready;

		new Notice("Connected to the server.");
		console.debug("[OPV] WebTransport connection successful.");

		const stream = await transport.createBidirectionalStream();
		const writer =
			stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
		const reader =
			stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

		const joinPacket: TransportPacket = {
			type: "join",
			channel_id: channelID,
			sender_id: senderId,
			nickname: plugin.settings.nickname,
			payload: "Hi!",
		};
		await sendRawJSON(writer, joinPacket);
		new Notice(`Joined the channel ${channelID}.`);

		plugin.activeWriter = writer;

		void readLoop(reader, app, plugin, writer);

		return transport;
	} catch (e) {
		switch (e) {
			case "WebTransportError: Opening handshake failed.": {
				console.debug(
					`[OPV] Server at ${url} is inaccessible. Retrying later...`,
				);
				new Notice(`Server is inaccessible. Retrying later...`);
				break;
			}
			default:
				console.error("Something went wrong", e);
				new Notice("Something went wrong.");
		}
		return null;
	}
}

export async function startHeartbeats(
	plugin: IOpVaultPlugin,
	writer: WritableStreamDefaultWriter<Uint8Array>,
	channelID: string,
) {
	if (plugin.heartbeatInterval) {
		clearInterval(plugin.heartbeatInterval);
		plugin.heartbeatInterval = null;
	}
	plugin.heartbeatInterval = setInterval(
		() =>
			void (async () => {
				if (writer) {
					try {
						// Send heartbeat to main channel
						const mainPacket = {
							type: "heartbeat",
							channel_id: channelID,
							sender_id: plugin.settings.senderId,
							payload: "ping",
						};
						await sendRawJSON(writer, mainPacket);

						// Send heartbeat to all file channels to keep them alive
						for (const item of plugin.settings.sharedItems) {
							const fileBeat = {
								type: "heartbeat",
								channel_id: item.id,
								sender_id: plugin.settings.senderId,
								payload: "ping",
							};
							await sendRawJSON(writer, fileBeat);
						}
						for (const group of plugin.settings.syncGroups) {
							const groupBeat = {
								type: "heartbeat",
								channel_id: group.id,
								sender_id: plugin.settings.senderId,
								payload: "ping",
							};
							await sendRawJSON(writer, groupBeat);
						}
						console.debug(
							`[OPV] Sent heartbeat pings (main + ${plugin.settings.sharedItems.length} file channels + ${plugin.settings.syncGroups.length} group channels).`,
						);
					} catch (e) {
						new Notice("Connection lost. Disconnecting...");
						console.debug(`[OPV] Connection lost during heartbeat: ${e}`);
						if (plugin.activeTransport) {
							plugin.activeTransport.close();
							plugin.activeTransport = null;
						}
						if (plugin.activeWriter) {
							try {
								await plugin.activeWriter.close();
							} catch (writerError) {
								console.debug(`[OPV] Error closing writer: ${writerError}`);
							}
							plugin.activeWriter = null;
						}
						if (plugin.heartbeatInterval) {
							clearInterval(plugin.heartbeatInterval);
							plugin.heartbeatInterval = null;
						}
						plugin.updatePresence(0);

						plugin.heartbeatInterval = setInterval(() => {
							plugin.tryConnect().catch((err) => {
								console.error("[OPV] Reconnect attempt failed:", err);
							});
						}, 6000);
					}
				}
			})(),
		10000,
	);
	return;
}
export async function disconnect(plugin: IOpVaultPlugin): Promise<null> {
	console.debug("[OPV] Disconnecting");

	await plugin.syncHandler.cleanup();

	if (!plugin.activeWriter || !plugin.activeTransport) {
		console.debug("[OPV] No active writer to disconnect.");
		return null;
	}

	await sendRawJSON(plugin.activeWriter, {
		type: "leave",
		channel_id: plugin.settings.channelName,
		sender_id: plugin.settings.senderId,
		payload: "Goodbye!",
	} as TransportPacket);

	plugin.activeTransport.close();
	plugin.activeTransport = null;
	await plugin.activeWriter.close();
	plugin.activeWriter = null;

	plugin.updatePresence(0);

	if (plugin.heartbeatInterval) {
		clearInterval(plugin.heartbeatInterval);
		plugin.heartbeatInterval = null;
	}

	new Notice("Disconnected from server.");
	console.debug("[OPV] Disconnected");
	return null;
}

export async function sendSecureMessage(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	channelId: string,
	senderId: string,
	innerData: InnerMessage,
	key: string,
) {
	const encryptedPayload = await encryptPacket(innerData, key);

	const packet: TransportPacket = {
		type: "message",
		channel_id: channelId,
		sender_id: senderId,
		payload: encryptedPayload,
	};

	await sendRawJSON(writer, packet);
}

export async function sendRawJSON(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	data:
		| TransportPacket
		| { type: string; channel_id: string; sender_id: string; payload: string },
) {
	try {
		console.debug("[DBG] [OPV] Sending JSON:", JSON.stringify(data));
		const encoder = new TextEncoder();
		await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
	} catch (e) {
		const errorStr = String(e);
		if (errorStr.includes("aborted") || errorStr.includes("closed")) {
			console.debug("[OPV] Cannot send message, connection is closed");
			throw e;
		} else {
			console.error("[OPV] Error sending message:", e);
			throw e;
		}
	}
}

// Legacy
// export async function sendJSON(writer: any, msg: Message) {
//   const jsonString = JSON.stringify(msg);
//   const encoder = new TextEncoder();
//  const data = encoder.encode(jsonString);
//  await writer.write(data);
// }

// key: string
// is not currently used and has been removed
async function readLoop(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	app: App,
	plugin: IOpVaultPlugin,
	writer: WritableStreamDefaultWriter<Uint8Array>,
) {
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				console.debug("[OPV] Stream closed.");
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let boundary = buffer.indexOf("\n");
			while (boundary !== -1) {
				const chunk = buffer.slice(0, boundary).trim();
				buffer = buffer.slice(boundary + 1);

				if (chunk.length === 0) {
					boundary = buffer.indexOf("\n");
					continue;
				}

				try {
					const message = JSON.parse(chunk) as TransportPacket;

					if (message.type === "user_list") {
						try {
							const users = JSON.parse(message.payload) as Record<
								string,
								string
							>;
							if (message.channel_id === plugin.settings.channelName) {
								const prev = new Map(plugin.onlineUsers);
								plugin.onlineUsers.clear();
								for (const [id, nickname] of Object.entries(users)) {
									plugin.onlineUsers.set(id, nickname || prev.get(id) || id);
								}
								const e = Array.from(plugin.onlineUsers.values());
								plugin.updatePresence(e.length);
								console.debug("[OPV] Current users in channel:", users);
								if (noticeDebounce) {
									clearTimeout(noticeDebounce);
								}
								noticeDebounce = setTimeout(() => {
									new Notice(`Currently online: ${e.length}`);
									noticeDebounce = null;
								}, 500);
							} else {
								if (!plugin.channelUsers.has(message.channel_id)) {
									plugin.channelUsers.delete(message.channel_id);
								}
								plugin.channelUsers.set(message.channel_id, new Set());
								const set = plugin.channelUsers.get(message.channel_id)!;
								Object.keys(users).forEach((id) => set.add(id));
							}
						} catch (e) {
							console.error("[OPV] Error parsing user list", e);
						}
						boundary = buffer.indexOf("\n");
						continue;
					}

					await handleIn(message, app, plugin, writer);
				} catch (e) {
					console.error("[OPV] Error parsing buffered chunk JSON", e);
				}
				boundary = buffer.indexOf("\n");
			}
		}
	} catch (e) {
		console.error(
			"[OPV] Error reading from stream. It's probably closed, but just in case it isn't:",
			e,
		);
	}
}

async function handleIn(
	message: TransportPacket,
	app: App,
	plugin: IOpVaultPlugin,
	writer: WritableStreamDefaultWriter<Uint8Array>,
) {
	if (message.type !== "message" || !message.payload) {
		console.error("[OPV] Invalid message", message);
		return;
	}
	let key: string = "";
	const sharedItem = plugin.settings.sharedItems.find(
		(i) => i.id === message.channel_id,
	);
	const groupItem = plugin.settings.syncGroups.find(
		(g) => g.id === message.channel_id,
	);
	if (message.channel_id === plugin.settings.channelName) {
		key = plugin.settings.encryptionKey;
	} else if (groupItem && groupItem.pin) {
		key = groupItem.pin;
	} else if (sharedItem) {
		key = sharedItem.pin || sharedItem.key;
	} else if (plugin.activeDownloads.has(message.channel_id)) {
		key = plugin.activeDownloads.get(message.channel_id) || "";
	} else {
		key = "";
	}

	const decrypted = await decryptPacket(message.payload, key);
	if (!decrypted || !decrypted.type) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}

	// console.debug(`[OPV] Received something: ${decrypted.type}`);

	switch (decrypted.type) {
		case "chat":
			new Notice(`From peer: ${decrypted.content}`);
			console.debug("[OPV] Chat message:", decrypted.content);
			break;
		case "file_start":
			if (!decrypted.fileId) {
				console.error("[OPV] Empty decrypted content", decrypted);
				return;
			}
			// Ignore missing fileId for now
			incomingFiles.set(decrypted.fileId, []);
			console.debug(
				`Incoming file: ${decrypted.filename} (ID: ${decrypted.fileId})`,
			);
			break;
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
			break;
		}
		case "file_end": {
			if (!decrypted.fileId) {
				console.error("[OPV] Empty decrypted content", decrypted);
				return;
			}
			if (!decrypted.filename || !incomingFiles.has(decrypted.fileId)) {
				console.debug("[OPV] Unknown inner message type:", decrypted);
				break;
			}
			const chunks = incomingFiles.get(decrypted.fileId);

			if (!chunks) {
				break;
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
			break;
		}
		case "download_request": {
			console.debug(`[OPV] Download request for: ${decrypted.shareId}`);

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
				break;
			}

			const shareItem = plugin.settings.sharedItems.find(
				(i: SharedItem) => i.id === decrypted.shareId,
			);

			if (!shareItem) {
				console.error(
					`[OPV] No shared item found for ID: ${decrypted.shareId}`,
				);
				break;
			}

			const expectedPin = shareItem.pin || "";
			const incomingPin = decrypted.pin || "";

			if (expectedPin !== incomingPin) {
				console.error(
					`[OPV] Invalid PIN for download request of share ID: ${decrypted.shareId}`,
				);
				break;
			}

			const fileToSend = app.vault.getAbstractFileByPath(shareItem.path);
			if (fileToSend instanceof TFile) {
				new Notice(`Sending shared file: ${fileToSend.basename}`);

				// const transferKey = plugin.settings.encryptionKey;
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
			break;
		}
		case "diffs": {
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
				break;
			}

			const filesToRequest: string[] = [];
			for (const remote of remoteFiles) {
				const local = app.vault.getAbstractFileByPath(remote.path);
				if (
					!local ||
					(local instanceof TFile && local.stat.mtime < remote.mtime)
				) {
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
			break;
		}
		case "changes": {
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
				break;
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
			break;
		}
		case "update": {
			if (!decrypted.content) {
				console.error("[OPV] Empty decrypted content", decrypted);
				return;
			}
			console.debug(`[OPV] Sync update for file: ${decrypted.path}`);

			const path = decrypted.path;
			if (!path) {
				console.error("[OPV] update message missing path");
				break;
			}
			await receiveFile(app, path, decrypted.content, "", true);
			break;
		}
		case "sync_vector":
		case "sync_snapshot":
		case "sync_update": {
			if (decrypted.syncPayload) {
				await plugin.syncHandler.handleSyncMessage(
					decrypted.type,
					message.channel_id,
					decrypted.syncPayload,
				);
			}
			break;
		}
		case "group_get": {
			if (decrypted.content) {
				const group = plugin.settings.syncGroups.find(
					(g) => g.id === decrypted.content,
				);
				if (!group) break;
				const response: InnerMessage = {
					type: "group_info",
					content: JSON.stringify(group),
				};
				await sendSecureMessage(
					writer,
					message.channel_id,
					plugin.settings.senderId,
					response,
					key,
				);
			} else {
				console.error("[OPV] group_get message missing content");
			}
			break;
		}
		case "group_info": {
			if (decrypted.content) {
				let group: SyncGroup;
				try {
					group = JSON.parse(decrypted.content) as SyncGroup;
				} catch (e) {
					console.error("[OPV] Error parsing group info payload", e);
					new Notice("Error parsing group info payload. Check console.");
					break;
				}

				const existingGroup = plugin.settings.syncGroups.find(
					(g) => g.id === group.id,
				);
				if (!existingGroup) {
					plugin.settings.syncGroups.push(group);
					await plugin.saveSettings();
					plugin.activeDownloads.delete(group.id);
					console.debug(`[OPV] Added sync group: ${group.id}`);
				}

				for (const file of group.files) {
					plugin.activeDownloads.set(file.id, file.pin || "");
					await requestFile(file.id, plugin, file.pin || "");
				}
			} else {
				console.error("[OPV] group_info message missing content");
			}
			break;
		}
		case "awareness": {
			if (decrypted.path && decrypted.awarenessPayload) {
				let sharedItem = plugin.settings.sharedItems.find(
					(i) => i.id === message.channel_id,
				);
				if (!sharedItem) {
					console.error(
						"[OPV] Awareness message for unknown shared item:",
						message.channel_id,
					);
					break;
				}
				await plugin.syncHandler.handleAwarenessUpdate(
					sharedItem.path,
					decrypted.awarenessPayload,
				);
			} else {
				console.error("[OPV] Invalid awareness message:", decrypted);
			}
			break;
		}
		default:
			console.error("[OPV] Unknown message type:", decrypted.type);
	}
}

export async function upload(
	modal: UploadModal,
	shareId: string,
	pin?: string,
) {
	const file = modal.file;
	const app = modal.app;
	const plugin = modal.plugin;
	const transport = plugin.activeTransport;
	const manifest: Manifest = {
		version: 1,
		owner: plugin.settings.senderId,
		updatedAt: Date.now(),
		updatedBy: plugin.settings.senderId,
		snapshots: [],
	};
	const snapshot: Snapshot = {
		iteration: 1,
		hash: "",
		size: file.stat.size,
		senderId: plugin.settings.senderId,
		ctime: Date.now(),
	};
	snapshot.hash = await getHash(await app.vault.readBinary(file));
	manifest.snapshots.push(snapshot);
	plugin.manifests.set(shareId, manifest);
	const existingManifest = plugin.manifests.get(shareId);
	if (existingManifest) {
		snapshot.iteration =
			existingManifest.snapshots[existingManifest?.snapshots.length - 1]
				.iteration + 1;
	}
	if (!transport) return new Notice("No active connection.");

	try {
		new Notice(`Uploading file: ${file.name}`);

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		// reader is not used in upload
		// const reader = stream.readable.getReader();

		const name = getDate() + "_" + snapshot.hash.slice(0, 8);
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

		const fileData = await app.vault.readBinary(file);
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
		const name = `${getDate()}_${snapshot.hash.slice(0, 8)}.yjs`;
		if (path && (await app.vault.adapter.exists(path))) {
			const stateFile = await app.vault.adapter.readBinary(path);
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
		} else {
			await writer.close();
			console.debug(`[OPV] No state file found for: ${file.path}.`);
			new Notice("Action could not be completed. Check console for details.");
		}
	} catch (e) {
		console.error("[OPV] Error during manifest upload", e);
		new Notice("Error during manifest upload.");
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

	if (
		plugin.channelUsers.has(shareId) &&
		plugin.channelUsers.get(shareId)!.size > 1
	) {
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
		`${latest.ctime}_${latest.hash.slice(0, 8)}`,
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

	// Determine where to save the file
	let inboxPath = plugin.settings.inboxPath;
	const existingItem = plugin.settings.sharedItems.find((i) => i.id === shareId);

	// If overwriting and item exists, use its path's parent folder as "inbox"
	// effectively telling receiveFile to update that specific file if names match
	if (overwrite && existingItem) {
		const fullPath = existingItem.path;
		// receiveFile uses inboxPath + filename.
		// If we want to overwrite 'folder/file.md', we should pass 'folder/' as inboxPath
		// and ensure filename matches 'file.md'.
		// However, receiveFile has specific logic.
		// Let's pass the exact logic:
		// If overwrite is true, receiveFile checks if app.vault.getAbstractFileByPath(finalName) exists.
		// We need to ensure finalName resolves to existingItem.path.
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

	if (path) {
		const statePath = plugin.syncHandler.getStatePath(path);
		// If updating, we might want to preserve the pin from the existing item if not passed
		const pin =
			key ||
			plugin.activeDownloads.get(shareId) ||
			existingItem?.pin ||
			"";

		const stateBuffer = await download(
			plugin,
			shareId,
			`${latest.ctime}_${latest.hash.slice(0, 8)}.yjs`,
		);

		if (stateBuffer) {
			let decryptedState: Uint8Array | null = null;
			if (pin) {
				decryptedState = await decryptBinary(stateBuffer, pin);
			} else {
				decryptedState = stateBuffer;
			}

			if (decryptedState) {
				await plugin.app.vault.adapter.writeBinary(
					statePath,
					decryptedState.buffer as ArrayBuffer,
				);
				console.debug(
					`[OPV] Saved state file for downloaded file at: ${statePath}`,
				);
			}
		}

		// Only add new SharedItem if it doesn't exist
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

		const tFile = plugin.app.vault.getAbstractFileByPath(path);
		if (tFile instanceof TFile) {
			// If we just updated, we might need to reload the Yjs doc in SyncHandler
			// But SyncHandler.startSync usually handles checking if doc exists.
			// If doc exists, we might need to re-apply the new state from disk.
			// For now, let's just ensure startSync is called.
			await plugin.syncHandler.startSync(tFile);
		}
	} else {
		console.warn(`[OPV] Failed to save/update file.`);
	}
}

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

export async function joinChannel(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	channelId: string,
	senderId: string,
	nickname: string,
) {
	const packet: TransportPacket = {
		type: "join",
		channel_id: channelId,
		sender_id: senderId,
		nickname: nickname,
		payload: "Transfer room :D",
	};
	await sendRawJSON(writer, packet);
	console.debug(`[OPV] Joined transfer channel ${channelId}`);
}

export async function leaveChannel(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	channelId: string,
	senderId: string,
) {
	// No nickname as they can just tell from the senderId I think maybe idk yet :sob:
	const packet: TransportPacket = {
		type: "leave",
		channel_id: channelId,
		sender_id: senderId,
		payload: "Cya later :)",
	};
	await sendRawJSON(writer, packet);
	console.debug(`[OPV] Left transfer channel ${channelId}`);
}
