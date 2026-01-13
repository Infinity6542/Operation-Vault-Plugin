import { Notice, App, TFile } from "obsidian";
import {
	encryptPacket,
	decryptPacket,
	arrayBufferToBase64,
	encryptBinary,
	decryptBinary,
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
} from "./types";

const incomingFiles = new Map<string, Uint8Array[]>();

export async function connectToServer(
	url: string,
	channelID: string,
	plugin: IOpVaultPlugin
): Promise<WebTransport | null> {
	const senderId = plugin.settings.senderId;
	const app = plugin.app;
	const devHash = "YXMEXpP8LEhSlktl8CyCWK48BpeqUMTLqDK0eziKncE=";
	const options: WebTransportOptions = {
		serverCertificateHashes: [
			{ algorithm: "sha-256", value: conversion(devHash).buffer as ArrayBuffer },
		],
	};

	try {
		const transport = new WebTransport(url, options);

		console.debug("[OPV] Attempting a connection to " + url);
		await transport.ready;

		new Notice("Connected to the server.");
		console.debug("[OPV] WebTransport connection successful.");

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
		const reader = stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

		const joinPacket: TransportPacket = {
			type: "join",
			channel_id: channelID,
			sender_id: senderId,
			payload: "Hi!",
		};
		await sendRawJSON(writer, joinPacket);
		new Notice(`Joined the channel ${channelID}.`);

		plugin.activeWriter = writer;

		void readLoop(reader, app, plugin, writer);

		setInterval(() => {
			if (writer) {
				const packet = {
					type: "heartbeat",
					channel_id: channelID,
					sender_id: plugin.settings.senderId,
					payload: "ping",
				};
				void sendRawJSON(writer, packet);
				console.debug("[OPV] Sent heartbeat ping.");
			}
		}, 10000);

		return transport;
	} catch (e) {
		console.error("Something went wrong", e);
		new Notice("something went wrong.");
		return null;
	}
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

async function sendRawJSON(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	data: TransportPacket | { type: string; channel_id: string; sender_id: string; payload: string }
) {
  console.debug("[DBG] [OPV] Sending JSON:", JSON.stringify(data));
	const encoder = new TextEncoder();
	await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
}

// Legacy
// export async function sendJSON(writer: any, msg: Message) {
//   const jsonString = JSON.stringify(msg);
//   const encoder = new TextEncoder();
//  const data = encoder.encode(jsonString);
//  await writer.write(data);
//}

// key: string
// is not currently used and has been removed
async function readLoop(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	app: App,
	plugin: IOpVaultPlugin,
	writer: WritableStreamDefaultWriter<Uint8Array>
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
							const users = JSON.parse(message.payload) as string[];
							plugin.onlineUsers = users;
							plugin.updatePresence(users.length);
							console.debug("[OPV] Current users in channel:", users);
							new Notice(`Currently online: ${users.length}`);
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
			"[OPV] Error reading from stream. It's probably closed, but just in case it isn't: ",
			e
		);
	}
}

async function handleIn(
	message: TransportPacket,
	app: App,
	plugin: IOpVaultPlugin,
	writer: WritableStreamDefaultWriter<Uint8Array>
) {
	if (message.type !== "message" || !message.payload) {
		console.error("[OPV] Invalid message", message);
		return;
	}
  let key: string = "";
  const sharedItem = plugin.settings.sharedItems.find(i => i.id === message.channel_id);

  if (sharedItem) {
    key = sharedItem.pin || sharedItem.pin;
  } else {
    // No key found
    console.debug(`[OPV] No key could be found for item ${message.channel_id}`);
  }
	const decrypted = await decryptPacket(message.payload, key);

	if (!decrypted) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}

	switch (decrypted.type) {
		case "chat":
			new Notice(`From peer: ${decrypted.content}`);
			console.debug("[OPV] Chat message:", decrypted.content);
			break;
		case "file_start":
			// Ignore missing fileId for now
			incomingFiles.set(decrypted.fileId, []);
			console.debug(
				`Incoming file: ${decrypted.filename} (ID: ${decrypted.fileId})`
			);
			break;
		case "file_chunk": {
			if (!decrypted.fileId || !incomingFiles.has(decrypted.fileId)) {
				console.debug("[OPV] file_chunk message with unknown fileId");
				return;
			}

			const chunkBytes = conversion(decrypted.content);
			incomingFiles.get(decrypted.fileId)?.push(chunkBytes);
			console.debug(
				`[OPV] Received chunk ${decrypted.chunkIndex} for file ID: ${decrypted.fileId}`
			);
			break;
		}
		case "file_end": {
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

			await receiveFile(app, decrypted.filename || "unnamed", base64String);
			incomingFiles.delete(decrypted.fileId);
			console.debug(`[OPV] Received file: ${decrypted.fileId}`);
			break;
		}
		case "download_request": {
			console.debug(`[OPV] Download request for: ${decrypted.shareId}`);

			const shareItem = plugin.settings.sharedItems.find(
				(i: SharedItem) => i.id === decrypted.shareId
			);

			if (!shareItem) {
				console.error(
					`[OPV] No shared item found for ID: ${decrypted.shareId}`
				);
				break;
			}
			if (shareItem.pin && shareItem.pin !== decrypted.pin) {
				console.error(
					`[OPV] Invalid PIN for shared item ID: ${decrypted.shareId}`
				);
				break;
			}

			const fileToSend = app.vault.getAbstractFileByPath(shareItem.path);
			if (fileToSend instanceof TFile) {
				new Notice(`Sending shared file: ${fileToSend.basename}`);

				await sendFileChunked(
					writer,
					plugin.settings.channelName,
					fileToSend,
					app,
					plugin.settings.senderId,
          key
				);
				shareItem.shares++;
				void plugin.saveSettings();
			}
			break;
		}
    case "diffs": {
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
        if (!local || (local instanceof TFile && local.stat.mtime < remote.mtime)) {
          filesToRequest.push(remote.path);
        }
      }

      if (filesToRequest.length > 0) {
        const req: SyncMessage = {
          type: "changes",
          path: "request_batch",
          payload: JSON.stringify(filesToRequest),
        }
        await sendSecureMessage(writer, plugin.settings.channelName, plugin.settings.senderId, req, key);
      }
      break;
    }
    case "changes": {
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
          await sendSecureMessage(writer, plugin.settings.channelName, plugin.settings.senderId, updateMessage, key);
        }
      }
      break;
    }
    case "update": {
      console.debug(`[OPV] Sync update for file: ${decrypted.path}`);

      const path = decrypted.path;
      // const content = base64ToArrayBuffer(decrypted.content);

      await receiveFile(app, path, decrypted.content, true);
      break;
    }
    case "sync_vector":
    case "sync_snapshot":
    case "sync_update": {
      if (decrypted.path && decrypted.syncPayload) {
        await plugin.syncHandler.handleSyncMessage(decrypted.type, decrypted.path, decrypted.syncPayload);
      }
      break;
    }
    case "awareness": {
      if (decrypted.path && decrypted.awarenessPayload) {
        plugin.syncHandler.handleAwarenessUpdate(
          decrypted.path,
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

export async function upload(modal: UploadModal, shareId: string, pin?: string) {
	const file = modal.file;
	const app = modal.app;
	const plugin = modal.plugin;
	const transport = plugin.activeTransport;
	if (!transport) return new Notice("No active connection.");

	try {
		new Notice(`Uploading file: ${file.name}`);

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		// reader is not used in upload
		// const reader = stream.readable.getReader();

		const header = JSON.stringify({ type: "upload", payload: shareId }) + "\n";
		const encoder = new TextEncoder();
		await writer.write(encoder.encode(header));

		const fileData = await app.vault.readBinary(file);
		const nameBytes = encoder.encode(file.name);

		const totalSize = 2 + nameBytes.length + fileData.byteLength;
		const packageBuffer = new Uint8Array(totalSize);

		packageBuffer[0] = nameBytes.length & 0xff;
		packageBuffer[1] = (nameBytes.length >> 8) & 0xff;
		packageBuffer.set(nameBytes, 2);
		packageBuffer.set(new Uint8Array(fileData), 2 + nameBytes.length);

		const key = pin && pin.length > 0 ? pin : plugin.settings.encryptionKey;
		const encryptedData = await encryptBinary(packageBuffer.buffer, key);

		await writer.write(encryptedData);
		await writer.close();

		new Notice(`Completed upload of file: ${file.name}`);
	} catch (e) {
		console.error("Error during file upload", e);
		new Notice("Error during file upload.");
	}
}

export async function download(
	shareId: string,
	app: App,
	plugin: IOpVaultPlugin,
	pin?: string
) {
	const transport = plugin.activeTransport;
	if (!transport) return new Notice("No active connection.");

	try {
		new Notice(`Downloading item "${shareId}"`);

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

		const header =
			JSON.stringify({ type: "download", payload: shareId }) + "\n";
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		await writer.write(encoder.encode(header));

		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.length;
		}

		if (size === 0) {
			new Notice("File is empty or is nonexistent.");
			return;
		}

		const encrypted = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			encrypted.set(chunk, offset);
			offset += chunk.length;
		}

		const key = pin && pin.length > 0 ? pin : plugin.settings.encryptionKey;
		let decrypted = await decryptBinary(encrypted, key);

		if (!decrypted) {
			new Notice("Decryption failed. Possibly wrong pin or key.");
			return;
		}

		const nameLen = decrypted[0] | (decrypted[1] << 8);
		const nameBytes = decrypted.slice(2, 2 + nameLen);
		const name = decoder.decode(nameBytes);
		decrypted = decrypted.slice(2 + nameLen);
		if (decrypted.buffer instanceof ArrayBuffer) {
			await receiveFile(app, name, arrayBufferToBase64(decrypted.buffer));
		} else {
			new Notice("Decrypted data is invalid.");
		}
	} catch (e) {
		console.error("[OPV] Error during file download", e);
		new Notice(
			"Error during file download. Check console for more information."
		);
	}
}

export async function remove(transport: WebTransport | null, shareId: string) {
	if (!transport) return new Notice("No active connection.");

	try {
		const encoder = new TextEncoder();
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		// In the future, read the response to make sure that the operation
		// was successful.
		// const reader = stream.readable.getReader();

		const header = JSON.stringify({ type: "remove", payload: shareId }) + "\n";
		await writer.write(encoder.encode(header));
		await writer.close();

		new Notice(`Delete request sent for item "${shareId}"`);
		console.debug(`[OPV] Delete request sent for item "${shareId}"`);
	} catch (e) {
		console.error("Error during delete request", e);
		new Notice(
			"Error during delete request. Check the console for more information."
		);
	}
}

export async function startSync(plugin: IOpVaultPlugin, pin?: string) {
  if (!plugin.activeWriter) {
    new Notice("No active connection for sync.");
    return;
  }

  const key = pin && pin.length > 0 ? pin : plugin.settings.encryptionKey;

  new Notice("Starting sync");
  console.debug("[OPV] Starting sync");

  console.debug("[OPV] Obtaining manifest")
  const files = plugin.app.vault.getFiles();
  const manifest: ManifestItem[] = files.map((f: TFile) => ({
    path: f.path,
    mtime: f.stat.mtime,
    size: f.stat.size,
  }));
  await sendSecureMessage(
    plugin.activeWriter,
    plugin.settings.channelName,
    plugin.settings.senderId,
    {
      type: "diffs",
      path: "manifest",
      content: JSON.stringify(manifest),
    },
    key
  );

  console.debug(`[OPV] Manifest sent with ${manifest.length} items`);
}
