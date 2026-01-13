import { App, TFile, Notice } from "obsidian";
import { sendSecureMessage } from "./transport";
import { getHash } from "./crypto";

function arrayBufferTobase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function generateFileId(): string {
	return Math.random().toString(36).substring(2, 15);
}

export async function sendFileChunked(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	channel: string,
	file: TFile,
	app: App,
	senderId: string,
  key: string,
) {
  // const channel = settings.channelName;
  // const senderId = settings.senderId;
  // const key = settings.encryptionKey;
	const chunkSize = 64 * 1024; // 64KB

	try {
		const arrayBuffer = await app.vault.readBinary(file);
		const totalBytes = arrayBuffer.byteLength;
		const fileId = generateFileId();
		const totalChunks = Math.ceil(totalBytes / chunkSize);

		// ol' reliable
		// new Notice(`Starting upload for ${file.name} (${totalBytes / 1024} KB).`);
		const progress = new Notice(`Preparing ${file.name}...`, 300000);
		console.debug(
			`[OPV] Beginning to send ${file.name} (${totalBytes}:${totalChunks}).`
		);

		// Let server now file incoming
		await sendSecureMessage(writer, channel, senderId, {
			type: "file_start",
			content: "",
			filename: file.name,
			fileId: fileId,
		}, key);

		let offset = 0;
		let chunkIndex = 0;
		let lastPercent = 0;

		while (offset < totalBytes) {
			const slice = arrayBuffer.slice(offset, offset + chunkSize);
			const base64Chunk = arrayBufferTobase64(slice);

			await sendSecureMessage(writer, channel, senderId, {
				type: "file_chunk",
				content: base64Chunk,
				fileId: fileId,
				chunkIndex: chunkIndex,
			}, key);

			offset += chunkSize;
			chunkIndex++;

			// Update progress
			const percentage = Math.floor((chunkIndex / totalChunks) * 100);
			console.debug(
				`[OPV] Sending ${file.name} (${chunkIndex}/${totalChunks}) - ${percentage}%`
			);

			if (percentage > lastPercent) {
				progress.setMessage(`Uploading ${file.name}: ${percentage}%`);
				lastPercent = percentage;
			}

			if (chunkIndex % 5 === 0) await new Promise((r) => setTimeout(r, 10));
		}

		// Transfer end notice
		await sendSecureMessage(writer, channel, senderId, {
			type: "file_end",
			content: "",
			fileId: fileId,
			filename: file.name,
		}, key);
		console.debug(`[OPV] Finished sending ${file.name}.`);

		progress.setMessage(`File ${file.name} was sent.`);

		setTimeout(() => {
			progress.hide();
		}, 3000);
	} catch (e) {
		console.error("[OPV] Error sending file in chunks:", e);
		const message = e instanceof Error ? e.message : String(e);
		new Notice(`Error while sending file: ${message}`);
	}
}

// This assumes that the filename has an extension which should probably be handled tbf
//TODO: effectively handle files without extensions
export function nameFile(oName: string, duplicate?: boolean): string {
	const name = oName.split("");
	const lastDot = oName.lastIndexOf(".");
	const extension = name.slice(lastDot).join("");
	let filename = name.slice(0, lastDot).join("");
	let finalName: string;

	if (duplicate) {
		finalName = `${filename}_copy${extension}`;
	} else {
		let count = 1;

		if (filename.endsWith(")")) {
			const openParenIndex = filename.lastIndexOf(" (");
			if (openParenIndex !== -1) {
				const numberString = filename.substring(
					openParenIndex + 2,
					filename.length - 1
				);
				const parsed = parseInt(numberString);
				if (!isNaN(parsed)) {
					count = parsed + 1;
					filename = filename.substring(0, openParenIndex);
				}
			}
		}
		finalName = `${filename} (${count})${extension}`;
	}

	return finalName;
}

export async function receiveFile(app: App, filename: string, content: string, overwrite?: boolean) {
	try {
		let finalName = filename;
		const incomingBytes = conversion(content);
		const incomingBuffer = incomingBytes.buffer;

		const existing = app.vault.getAbstractFileByPath(finalName);
		let duplicate = false;

    if (overwrite && existing instanceof TFile) {
      console.debug(`[OPV] Overwriting existing file: ${finalName}`);
      await app.vault.modifyBinary(existing, incomingBuffer as ArrayBuffer);
      new Notice(`Overwritten file: ${finalName}.`);
      return;
    }

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

		console.debug(`[OPV] Saving as ${finalName}`);
		await app.vault.createBinary(finalName, incomingBuffer as ArrayBuffer);
		new Notice(`Saved file: ${finalName}.`);
		return;
	} catch (e) {
		console.error("[OPV] Error while saving file", e);
		new Notice("Error saving file.");
	}
}

export function conversion(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const len = binaryString.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}
