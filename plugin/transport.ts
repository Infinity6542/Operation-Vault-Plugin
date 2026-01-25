import { Notice, App } from "obsidian";
import { decryptPacket } from "./crypto";
import { conversion } from "./fileHandler";
import type { IOpVaultPlugin, TransportPacket } from "./types";
import { sendRawJSON } from "./networking";
import {
	handleFileIn,
	fileEnd,
	downloadRequest,
} from "./handlers/fileTransfer";
import { update, awareness, sync, diffs, changes } from "./handlers/awareness";
import { manifestUpdate, groupGet, groupInfo } from "./handlers/state";

let noticeDebounce: ReturnType<typeof setTimeout> | undefined = undefined;

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
						userList(plugin, message);
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

function userList(plugin: IOpVaultPlugin, message: TransportPacket) {
	try {
		const users = JSON.parse(message.payload) as Record<string, string>;
		if (message.channel_id === plugin.settings.channelName) {
			const prev = new Map(plugin.onlineUsers);
			plugin.onlineUsers.clear();
			for (const [id, nickname] of Object.entries(users)) {
				plugin.onlineUsers.set(id, nickname || prev.get(id) || id);
			}
			const e = Array.from(plugin.onlineUsers.values());
			plugin.updatePresence(e.length);
			console.debug("[OPV] Current users in channel:", users);
			clearTimeout(noticeDebounce);
			noticeDebounce = setTimeout(() => {
				new Notice(`Currently online: ${e.length}`);
				noticeDebounce = undefined;
			}, 500);
		} else {
			plugin.channelUsers.delete(message.channel_id);
			plugin.channelUsers.set(message.channel_id, new Set());
			const set = plugin.channelUsers.get(message.channel_id)!;
			Object.keys(users).forEach((id) => set.add(id));
		}
	} catch (e) {
		console.error("[OPV] Error parsing user list", e);
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

	console.debug(
		`[OPV] Received packet type ${message.type} for ${message.channel_id} from ${message.sender_id}`,
	);

	const decrypted = await decryptPacket(message.payload, key);
	if (!decrypted || !decrypted.type) {
		console.error(
			`[OPV] Empty decrypted content or decryption failed for ${message.channel_id}`,
			decrypted,
		);
		return;
	}

	switch (decrypted.type) {
		// decrypted
		case "file_start":
		case "file_chunk": {
			handleFileIn(decrypted);
			break;
		}
		// decrypted, app
		case "update": {
			await update(decrypted, app);
			break;
		}
		// plugin, decrypted
		case "group_info": {
			await groupInfo(plugin, decrypted);
			break;
		}
		// plugin, decrypted, message
		case "awareness": {
			await awareness(plugin, decrypted, message);
			break;
		}
		case "manifest_update": {
			manifestUpdate(plugin, decrypted, message);
			break;
		}
		case "sync_vector":
		case "sync_snapshot":
		case "sync_update": {
			await sync(plugin, decrypted, message);
			break;
		}
		// plugin, decrypted, message, writer
		case "download_request": {
			await downloadRequest(plugin, decrypted, message, writer);
			break;
		}
		// plugin, decrypted, message, key
		case "file_end": {
			await fileEnd(plugin, decrypted, message, key);
			break;
		}
		case "diffs": {
			await diffs(plugin, decrypted, writer, key);
			break;
		}
		case "changes": {
			await changes(plugin, decrypted, writer, key);
			break;
		}
		// plugin, decrypted, message, writer, key
		case "group_get": {
			await groupGet(plugin, decrypted, message, writer, key);
			break;
		}
		default:
			console.error("[OPV] Unknown message type:", decrypted.type);
	}
}
