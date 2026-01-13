import { App, TFile, EventRef } from "obsidian";
import { SyncHandler } from "./syncHandler";

export interface IOpVaultPlugin {
	settings: PluginSettings;
	app: App;
	activeWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	activeTransport: WebTransport | null;
  syncHandler: SyncHandler;
	onlineUsers: string[];
	updatePresence(count: number): void;
	saveSettings(): Promise<void>;
  registerEvent(event: EventRef): void;
}

export interface InnerMessage {
	type: "chat" | "file_start" | "file_chunk" | "file_end" | "download_request" | "diffs" | "changes" | "update" | "sync_vector" | "sync_snapshot" | "sync_update" | "awareness";
	content?: string;
	filename?: string;
	fileId?: string;
	chunkIndex?: number;
	shareId?: string;
	pin?: string;
  path?: string;
  syncPayload?: string;
  awarenessPayload?: string;
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

export interface UploadModal {
	file: TFile;
	app: App;
	plugin: IOpVaultPlugin;
}

export interface SyncMessage {
  type: "diffs" | "changes" | "update";
  path: string;
  payload: string;
}

export interface ManifestItem {
  path: string;
  mtime: number;
  size?: number;
  hash?: string;
}
