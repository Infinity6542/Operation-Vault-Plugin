import {
	AbstractInputSuggest,
	App,
	prepareFuzzySearch,
	renderMatches,
} from "obsidian";
import { FolderMatch } from "./types";

export class FolderSelector extends AbstractInputSuggest<FolderMatch> {
	inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	getSuggestions(query: string): FolderMatch[] {
		const searchFn = prepareFuzzySearch(query);
		const folders = this.app.vault.getAllFolders(true);
		const results: FolderMatch[] = [];

		for (const folder of folders) {
			const match = searchFn(folder.path);
			if (match) {
				results.push({ item: folder, match });
			}
		}

		return results.sort((a, b) => b.match.score - a.match.score);
	}

	renderSuggestion(value: FolderMatch, el: HTMLElement): void {
		renderMatches(el, value.item.path, value.match.matches);
	}

	selectSuggestion(value: FolderMatch): void {
		this.inputEl.value = value.item.path;
		this.inputEl.trigger("input");
		this.close();
	}
}
