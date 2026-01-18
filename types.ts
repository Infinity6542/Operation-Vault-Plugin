import { App, EventRef, TFile, TFolder, SearchResult } from "obsidian";
import { SyncHandler } from "./syncHandler";

export interface IOpVaultPlugin {
	settings: PluginSettings;
	app: App;
	activeWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	activeTransport: WebTransport | null;
	syncHandler: SyncHandler;
	onlineUsers: string[];
	activeDownloads: Map<string, string>;
	heartbeatInterval: ReturnType<typeof setTimeout> | null;
	updatePresence(count: number): void;
	saveSettings(): Promise<void>;
	registerEvent(event: EventRef): void;
	tryConnect(): Promise<void>;
}

export interface InnerMessage {
	type:
		| "chat"
		| "file_start"
		| "file_chunk"
		| "file_end"
		| "download_request"
		| "diffs"
		| "changes"
		| "update"
		| "sync_vector"
		| "sync_snapshot"
		| "sync_update"
		| "get_group"
		| "group_info"
		| "awareness";
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
	type: "join" | "message" | "user_list" | "heartbeat" | "leave";
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
	groups?: string[];
}

export interface PluginSettings {
	serverUrl: string;
	channelName: string;
	encryptionKey: string;
	senderId: string;
	sharedItems: SharedItem[];
	inboxPath: string;
	syncGroups: SyncGroup[];
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

export interface FolderMatch {
	item: TFolder;
	match: SearchResult;
}

export interface FileMatch {
	item: TFile;
	match: SearchResult;
}

export interface SyncGroup {
	id: string;
	files: SharedItem[];
	pin?: string;
}

// Experimental, to be implemented later during a refactor
export interface opError {
	code: number;
	// Message is optional if the code is 0.
	message?: string;
}

