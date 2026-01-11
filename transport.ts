import { Notice, App, TFile } from "obsidian";
import {
	encryptPacket,
	decryptPacket,
	getHash,
	arrayBufferToBase64,
  encryptBinary,
  decryptBinary,
} from "./crypto";
import { nameFile, sendFileChunked } from "./fileHandler";

interface innerMessage {
	type: "chat" | "file_start" | "file_chunk" | "file_end" | "download_request";
	content?: string;
	filename?: string;
	fileId?: string;
	chunkIndex?: number;
	shareId?: string;
	pin?: string;
}

interface TransportPacket {
	type: "join" | "message";
	channel_id: string;
  sender_id: string;
	payload: string; // Encrypted
}

const incomingFiles = new Map<string, Uint8Array[]>();

export async function connectToServer(
	url: string,
	channelID: string,
  senderId: string,
	app: App,
	plugin: any
): Promise<any> {
	const devHash = "YXMEXpP8LEhSlktl8CyCWK48BpeqUMTLqDK0eziKncE=";
	const options: any = {
		serverCertificateHashes: [
			{ algorithm: "sha-256", value: conversion(devHash) },
		],
	};

	try {
		const transport = new WebTransport(url, options);

		console.info("[OPV] Attempting a connection to " + url);
		await transport.ready;

		new Notice("Connected to the server.");
		console.info("[OPV] WebTransport connection successful.");

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		const joinPacket: TransportPacket = {
			type: "join",
			channel_id: channelID,
      sender_id: senderId,
			payload: "Hi!",
		};
		await sendRawJSON(writer, joinPacket);
		new Notice(`Joined the channel ${channelID}.`);

    plugin.activeWriter = writer;

		readLoop(reader, app, plugin, writer);

    setInterval(async () => {
      if (writer) {
        const packet = {
          type: "heartbeat",
          channel_id: channelID,
          sender_id: plugin.settings.senderId,
          payload: "ping",
        };
        await sendRawJSON(writer, packet);
        console.info("[OPV] Sent heartbeat ping.");
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
	writer: any,
	channelId: string,
  senderId: string,
	innerData: innerMessage
) {
	const encryptedPayload = await encryptPacket(innerData);

	const packet: TransportPacket = {
		type: "message",
		channel_id: channelId,
    sender_id: senderId,
		payload: encryptedPayload,
	};

	await sendRawJSON(writer, packet);
}

async function sendRawJSON(writer: any, data: any) {
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
async function readLoop(reader: any, app: App, plugin: any, writer: any) {
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				console.info("[OPV] Stream closed.");
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let boundary = buffer.indexOf("\n");
			while (boundary !== -1) {
				const chunk = buffer.slice(0, boundary).trim();
				buffer = buffer.slice(boundary + 1);

				if (chunk.length > 0) {
					try {
						const message = JSON.parse(chunk);

            if (message.type === "user_list") {
              try {
                const users = JSON.parse(message.payload);
                plugin.onlineUsers = users;
                plugin.updatePresence(users.length);
                console.info("[OPV] Current users in channel:", users);
                new Notice(`Currently online: ${users.length}`)
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

async function handleIn(message: any, app: App, plugin: any, writer: any) {
	if (message.type !== "message" || !message.payload) {
		console.error("[OPV] Invalid message", message);
		return;
	}
	const decrypted = await decryptPacket(message.payload);

	if (!decrypted) {
		console.error("[OPV] Empty decrypted content", decrypted);
		return;
	}

	switch (decrypted.type) {
		case "chat":
			new Notice(`From peer: ${decrypted.content}`);
			console.info("[OPV] Chat message:", decrypted.content);
			break;
		case "file_start":
			// Ignore missing fileId for now
			incomingFiles.set(decrypted.fileId, []);
			console.info(
				`Incoming file: ${decrypted.filename} (ID: ${decrypted.fileId})`
			);
			break;
		case "file_chunk":
			if (decrypted.fileId && incomingFiles.has(decrypted.fileId)) {
				const chunkBytes = conversion(decrypted.content);
				incomingFiles.get(decrypted.fileId)?.push(chunkBytes);
				console.info(
					`[OPV] Received chunk ${decrypted.chunkIndex} for file ID: ${decrypted.fileId}`
				);
			} else {
				console.info("[OPV] file_chunk message with unknown fileId");
				return;
			}
			break;
		case "file_end":
			if (!decrypted.filename || !incomingFiles.has(decrypted.fileId!)) {
				console.info("[OPV] Unknown inner message type:", decrypted);
				break;
			}
			const chunks = incomingFiles.get(decrypted.fileId)!;

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
			console.info(`[OPV] Received file: ${decrypted.fileId}`);
			break;
		case "download_request":
			console.info(`[OPV] Download request for: ${decrypted.shareId}`);

			const shareItem = plugin.settings.sharedItems.find(
				(i: any) => i.id === decrypted.shareId
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
				);
				shareItem.shares++;
				plugin.saveSettings();
			}
			break;
		default:
			console.error("[OPV] Unknown message type:", decrypted.type);
	}
}

function conversion(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const len = binaryString.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

async function receiveFile(app: App, filename: string, content: string) {
	try {
		let finalName = filename;
		const incomingBytes = conversion(content);
		const incomingBuffer = incomingBytes.buffer;

		const existing = app.vault.getAbstractFileByPath(finalName);
		let duplicate = false;

		if (existing instanceof TFile && incomingBuffer instanceof ArrayBuffer) {
			const existingBuffer = await app.vault.readBinary(existing);

			const existingHash = await getHash(existingBuffer);
			const incomingHash = await getHash(incomingBuffer);

			duplicate = existingHash === incomingHash;
		}

		if (existing) {
			while (app.vault.getAbstractFileByPath(finalName)) {
				finalName = nameFile(finalName, duplicate);
			}
			new Notice(`File exists. Saving as ${finalName}`);
		}

		console.info(`[OPV] Saving as ${finalName}`);
		await app.vault.createBinary(finalName, incomingBuffer as ArrayBuffer);
		new Notice(`Saved file: ${finalName}.`);
		return;
	} catch (e) {
		console.error("[OPV] Error while saving file", e);
		new Notice("Error saving file.");
	}
}

export async function upload(file: TFile, app: App, shareId: string, plugin: any, pin?: string) {
  const transport = plugin.activeTransport;
  if (!transport) return new Notice ("No active connection.");

  try {
    new Notice(`Uploading file: ${file.name}`);

    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    // reader is not used in upload
    // const reader = stream.readable.getReader();

    const header = JSON.stringify({ type: "upload", payload: shareId}) + "\n";
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(header));

    const fileData = await app.vault.readBinary(file);
    const nameBytes = encoder.encode(file.name);

    const totalSize = 2 + nameBytes.length + fileData.byteLength;
    const packageBuffer = new Uint8Array(totalSize);

    packageBuffer[0] = nameBytes.length & 0xff;
    packageBuffer[1] = (nameBytes.length >>8) & 0xff;
    packageBuffer.set(nameBytes, 2);
    packageBuffer.set(new Uint8Array(fileData), 2 + nameBytes.length);

    const key = (pin && pin.length > 0) ? pin : plugin.settings.encryptionKey;
    console.log(key);
    const encryptedData = await encryptBinary(packageBuffer.buffer, key);

    await writer.write(encryptedData);
    await writer.close();

    new Notice(`Completed upload of file: ${file.name}`);
  } catch (e) {
    console.error("Error during file upload", e);
    new Notice("Error during file upload.");
  }
}

export async function download(shareId: string, app: App, plugin: any, pin?: string) {
  const transport = plugin.activeTransport;
  if (!transport) return new Notice ("No active connection.");

  try {
    new Notice(`Downloading item "${shareId}"`);

    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const header = JSON.stringify({ type: "download", payload: shareId}) + "\n";
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

    const key = (pin && pin.length > 0) ? pin : plugin.settings.encryptionKey;
    console.log(key);
    let decrypted = await decryptBinary(encrypted, key);

    if (!decrypted) {
      new Notice("Decryption failed. Possibly wrong PIN or key.");
      return;
    }

    const nameLen = (decrypted[0]) | (decrypted[1] << 8);
    const nameBytes = decrypted.slice(2, 2 + nameLen);
    const name = decoder.decode(nameBytes);
    decrypted = decrypted.slice(2 + nameLen);

    if (decrypted.buffer instanceof ArrayBuffer) {
      receiveFile(app, name, arrayBufferToBase64(decrypted.buffer));
    } else {
      new Notice("Decrypted data is invalid.");
    }
  } catch (e) {
    console.error("[OPV] Error during file download", e);
    new Notice("Error during file download. Check console for more information.");
  }
}

export async function remove(transport: any, shareId: string) {
  if (!transport) return new Notice ("No active connection.");

  try {
    const encoder = new TextEncoder();
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    // In the future, read the response to make sure that the operation
    // was successful.
    // const reader = stream.readable.getReader();
    
    const header = JSON.stringify({ type: "remove", payload: shareId}) + "\n";
    await writer.write(encoder.encode(header));
    await writer.close();

    new Notice(`Delete request sent for item "${shareId}"`);
    console.info(`[OPV] Delete request sent for item "${shareId}"`);
  } catch (e) {
    console.error("Error during delete request", e);
    new Notice("Error during delete request. Check the console for more information.");
  }
}
