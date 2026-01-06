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
	serverHash: string,
	channelID: string,
	app: App
) {
	const url = "https://127.0.0.1:8080/ws";
	const options: any = {
		serverCertificateHashes: [
			{ algorithm: "sha-256", value: conversion(serverHash) },
		],
	};

	try {
		const transport = new WebTransport(url, options);
		console.log("Attempting a connection to " + url);
		await transport.ready;
		new Notice("Connected to the server.");
		console.log("WebTransport connection successful.");

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
			const { value, done } = await reader.read();
			if (done) {
				console.log("Stream closed");
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
						console.error("Error parsing buffered chunk JSON", e);
					}
				}
				boundary = buffer.indexOf("\n");
			}
		}
	} catch (e) {
		console.error(
			"Error reading from stream. It's probably closed, but just in case it isn't: ",
			e
		);
	}
}

async function handleIn(message: any, app: App) {
	if (message.type !== "message" && !message.payload) {
		console.error("Invalid message", message);
		return;
	}
	const decrypted = await decryptPacket(message.payload);

	if (!decrypted) {
		console.error("Empty decrypted content", decrypted);
	}

	switch (decrypted.type) {
		case "chat":
			new Notice(`From peer: ${decrypted.content}`);
			console.log("Chat message:", decrypted.content);
		case "file_start":
			if (decrypted.fileId) {
				incomingFiles.set(decrypted.fileId, []);
				console.log(
					`Incoming file: ${decrypted.filename} (ID: ${decrypted.fileId})`
				);
			} else {
				console.log("file_start message missing fileId");
				return;
			}
		case "file_chunk":
			if (decrypted.fileId && incomingFiles.has(decrypted.fileId)) {
				const chunkBytes = conversion(decrypted.content);
				incomingFiles.get(decrypted.fileId)?.push(chunkBytes);
				console.log(
					`Received chunk ${decrypted.chunkIndex} for file ID: ${decrypted.fileId}`
				);
			} else {
				console.log("file_chunk message with unknown fileId");
				return;
			}
		case "file_end":
			if (!decrypted.filename && !incomingFiles.has(decrypted.fileId!)) {
				console.log("Unknown inner message type:", decrypted);
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
			console.log(`Received file: ${decrypted.fileId}`);
		default:
			console.error("Unknown message type:", decrypted.type);
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

		if (existing) {
			if (existing instanceof TFile && incomingBuffer instanceof ArrayBuffer) {
				const existingBuffer = await app.vault.readBinary(existing);

				const existingHash = await getHash(existingBuffer);
				const incomingHash = await getHash(incomingBuffer);
				if (existingHash === incomingHash) {
					while (app.vault.getAbstractFileByPath(finalName)) {
						finalName = nameFile(finalName, true);
					}
				} else {
					while (app.vault.getAbstractFileByPath(finalName)) {
						finalName = nameFile(finalName, false);
					}
				}
			} else {
				while (app.vault.getAbstractFileByPath(finalName)) {
					finalName = nameFile(finalName, false);
				}
			}
			new Notice(`File exists. Saving as ${finalName}`);
		}

		console.log(`Saving as ${finalName}`);
		await app.vault.createBinary(finalName, incomingBuffer as ArrayBuffer);
		new Notice(`Saved file: ${finalName}.`);
		return;
	} catch (e) {
		console.error("Error while saving file", e);
		new Notice("Error saving file.");
	}
}
