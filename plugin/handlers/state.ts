import { Notice } from "obsidian";
import {
	IOpVaultPlugin,
	InnerMessage,
	TransportPacket,
	Manifest,
    SyncGroup
} from "../types";
import { sendSecureMessage } from "../networking";
import { requestFile } from "./fileTransfer"

export function manifestUpdate(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	message: TransportPacket,
) {
	try {
		const manifest = JSON.parse(decrypted.content as string) as Manifest;
		plugin.manifests.set(message.channel_id, manifest);
		console.debug(
			`[OPV] Updated manifest for shared item: ${message.channel_id}`,
		);
		plugin.app.workspace.trigger("opv:snapshot-created", message.channel_id);
	} catch (e) {
		console.error("[OPV] Error parsing manifest update payload", e);
	}
}

export async function groupGet(
	plugin: IOpVaultPlugin,
	decrypted: InnerMessage,
	message: TransportPacket,
	writer: WritableStreamDefaultWriter<Uint8Array>,
	key: string,
) {
	if (decrypted.content) {
		const group = plugin.settings.syncGroups.find(
			(g) => g.id === decrypted.content,
		);
		if (!group) return;
		const response: InnerMessage = {
			type: "group_info",
			content: JSON.stringify(group),
		};
		await sendSecureMessage(
			writer,
			message.channel_id,
			plugin.settings.senderId,
			response,
			key,
		);
	} else {
		console.error("[OPV] group_get message missing content");
	}
}

export async function groupInfo(plugin: IOpVaultPlugin, decrypted: InnerMessage) {
	if (decrypted.content) {
		let group: SyncGroup;
		try {
			group = JSON.parse(decrypted.content) as SyncGroup;
		} catch (e) {
			console.error("[OPV] Error parsing group info payload", e);
			new Notice("Error parsing group info payload. Check console.");
			return;
		}

		const existingGroup = plugin.settings.syncGroups.find(
			(g) => g.id === group.id,
		);
		if (!existingGroup) {
			plugin.settings.syncGroups.push(group);
			await plugin.saveSettings();
			plugin.activeDownloads.delete(group.id);
			console.debug(`[OPV] Added sync group: ${group.id}`);
		}

		for (const file of group.files) {
			plugin.activeDownloads.set(file.id, file.pin || "");
			await requestFile(file.id, plugin, file.pin || "");
		}
	} else {
		console.error("[OPV] group_info message missing content");
	}
}
