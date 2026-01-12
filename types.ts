import { App, TFile } from "obsidian";

export interface innerMessage {
	type: "chat" | "file_start" | "file_chunk" | "file_end" | "download_request";
	content?: string;
	filename?: string;
	fileId?: string;
	chunkIndex?: number;
	shareId?: string;
	pin?: string;
}

export interface TransportPacket {
	type: "join" | "message" | "user_list" | "heartbeat";
	channel_id: string;
	sender_id: string;
	payload: string;
}

export interface SharedItem {
	id: string;
	path: string;
	pin?: string;
	key: string;
	createdAt: number;
	shares: number;
}

export interface PluginSettings {
	serverUrl: string;
	channelName: string;
	encryptionKey: string;
	senderId: string;
	sharedItems: SharedItem[];
}

export interface IOpVaultPlugin {
	settings: PluginSettings;
	app: App;
	activeWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	activeTransport: WebTransport | null;
	onlineUsers: string[];
	updatePresence(count: number): void;
	saveSettings(): Promise<void>;
}

export interface UploadModal {
	file: TFile;
	app: App;
	plugin: IOpVaultPlugin;
}
