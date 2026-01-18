import type { InnerMessage } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SALT_LEN: number = 16;
const IV_LEN: number = 12;
const ITERATIONS: number = 100000;
const KEY_LEN: number = 256;

async function getKey(password: string, salt: BufferSource) {
	const keyMaterial = await window.crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		{ name: "PBKDF2" },
		false,
		["deriveKey"],
	);

	return window.crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: salt,
			iterations: ITERATIONS,
			hash: "SHA-256",
		},
		keyMaterial,
		{ name: "AES-GCM", length: KEY_LEN },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptPacket(
	data: InnerMessage,
	secret: string,
): Promise<string> {
	const salt = window.crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const key = await getKey(secret, salt);
	const iv = window.crypto.getRandomValues(new Uint8Array(IV_LEN));
	const jsonStr = JSON.stringify(data);

	const encrypted = await window.crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: iv,
		},
		key,
		encoder.encode(jsonStr),
	);

	const packageData = {
		salt: arrayBufferToBase64(salt.buffer),
		iv: arrayBufferToBase64(iv.buffer),
		data: arrayBufferToBase64(encrypted),
	};

	return JSON.stringify(packageData);
}

export async function decryptPacket(
	payload: string,
	secret: string,
): Promise<InnerMessage | null> {
	try {
		const pkg = JSON.parse(payload) as {
			salt: string;
			iv: string;
			data: string;
		};

		if (!pkg.iv || !pkg.data || !pkg.salt) {
			throw new Error("Invalid payload structure");
		}

		const salt = base64ToArrayBuffer(pkg.salt);
		const iv = base64ToArrayBuffer(pkg.iv);
		const key = await getKey(secret, new Uint8Array(salt));
		const encryptedContent = base64ToArrayBuffer(pkg.data);

		const decryptedBytes = await window.crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv,
			},
			key,
			encryptedContent,
		);

		const decryptedStr = decoder.decode(decryptedBytes);
		return JSON.parse(decryptedStr) as InnerMessage;
	} catch (e) {
		console.error("[OPV] Decryption failed:", e);
		return null;
	}
}

export async function encryptBinary(
	data: ArrayBuffer,
	keyStr: string,
): Promise<Uint8Array> | null {
	try {
		const salt = window.crypto.getRandomValues(new Uint8Array(SALT_LEN));
		const iv = window.crypto.getRandomValues(new Uint8Array(IV_LEN));
		const key = await getKey(keyStr, salt);

		const encrypted = await window.crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: iv,
			},
			key,
			data,
		);

		const result = new Uint8Array(
			salt.byteLength + iv.byteLength + encrypted.byteLength,
		);
		result.set(salt, 0);
		result.set(iv, salt.length);
		result.set(new Uint8Array(encrypted), iv.length + salt.length);

		return result;
	} catch (e) {
		console.error("[OPV] Binary encryption failed:", e);
		return null;
	}
}

export async function decryptBinary(
	data: Uint8Array,
	keyStr: string,
): Promise<Uint8Array> | null {
	try {
		const salt = data.slice(0, SALT_LEN);
		const iv = data.slice(SALT_LEN, SALT_LEN + IV_LEN);
		const encrypted = data.slice(SALT_LEN + IV_LEN);

		const key = await getKey(keyStr, salt);
		const decrypted = await window.crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv,
			},
			key,
			encrypted,
		);

		return new Uint8Array(decrypted);
	} catch (e) {
		console.error("[OPV] Binary decryption failed:", e);
		return null;
	}
}

// Helpers
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
}

export async function getHash(input: ArrayBuffer): Promise<string> {
	// Input the binary
	// For files, use app.vault.readBinary(file) to get ArrayBuffer
	const hashBuffer = await window.crypto.subtle.digest("SHA-256", input);

	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return hashHex;
}
