import { Notice, App, TFile } from "obsidian";
import {
	encryptPacket,
	decryptPacket,
	getHash,
	arrayBufferToBase64,
} from "./crypto";
import { nameFile } from "./fileHandler";

interface innerMessage {
	type: "chat" | "file_start" | "file_chunk" | "file_end";
	content: string;
	filename?: string;
	fileId?: string;
	chunkIndex?: number;
}

interface TransportPacket {
	type: "join" | "message";
	channel_id: string;
	payload: string; // Encrypted
}

const incomingFiles = new Map<string, Uint8Array[]>();

export async function connectToServer(
	url: string,
	channelID: string,
	app: App
) {
	const devHash = "YXMEXpP8LEhSlktl8CyCWK48BpeqUMTLqDK0eziKncE=";
	const options: any = {
		serverCertificateHashes: [
			{ algorithm: "sha-256", value: conversion(devHash) },
		],
	};

	try {
		const transport = new WebTransport(url, options);

		console.info("Attempting a connection to " + url);
		await transport.ready;

		new Notice("Connected to the server.");
		console.info("WebTransport connection successful.");

		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		const joinPacket: TransportPacket = {
			type: "join",
			channel_id: channelID,
			payload: "Hi!",
		};
		await sendRawJSON(writer, joinPacket);
		new Notice(`Joined the channel ${channelID}.`);

		readLoop(reader, app);
		return writer;
	} catch (e) {
		console.error("Something went wrong", e);
		new Notice("something went wrong.");
		return null;
	}
}

export async function sendSecureMessage(
	writer: any,
	channelId: string,
	innerData: innerMessage
) {
	const encryptedPayload = await encryptPacket(innerData);

	const packet: TransportPacket = {
		type: "message",
		channel_id: channelId,
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

async function readLoop(reader: any, app: App) {
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
      console.info("[OPV] Awaiting data.")
			const { value, done } = await reader.read();
      console.info("[OPV] Received data.");
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
						await handleIn(message, app);
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

async function handleIn(message: any, app: App) {
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
			if (decrypted.fileId) {
				incomingFiles.set(decrypted.fileId, []);
				console.info(
					`Incoming file: ${decrypted.filename} (ID: ${decrypted.fileId})`
				);
			} else {
				console.info("[OPV] file_start message missing fileId");
				return;
			}
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
