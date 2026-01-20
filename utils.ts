import { App, TFile } from "obsidian";
// import { IOpVaultPlugin } from "types";

export function getFile(app: App, path: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}