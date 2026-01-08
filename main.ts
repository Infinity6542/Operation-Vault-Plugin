import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { connectToServer, sendSecureMessage } from "./transport";
import { sendFileChunked } from "./fileHandler";

interface settings {
	serverUrl: string;
	channelName: string;
	encryptionKey: string;
}

const defaultSettings: settings = {
	serverUrl: "https://127.0.0.1:8080/ws",
	channelName: "vault-1",
	encryptionKey: "wow-really-cool-secret-444",
};

export default class OpVaultPlugin extends Plugin {
	settings: settings;
	activeWriter: any = null;

	async onload() {
		console.info("[OPV] Loading client...");
		await this.loadSettings();

		this.addSettingTab(new vaultSettingsTab(this.app, this));

		this.addRibbonIcon("dice", "Test connection", async () => {
			const url = this.settings.serverUrl;
			const channel = this.settings.channelName;

			new Notice("Trying connection...");
			this.activeWriter = await connectToServer(url, channel, this.app);
		});

		this.addRibbonIcon("text", "Chat", async () => {
			if (!this.activeWriter) {
				new Notice("Not connected to server.");
				console.info("[OPV] No active writer found.");
				return;
			}
			new Notice("Broadcasting message...");
			await sendSecureMessage(this.activeWriter, this.settings.channelName, {
				type: "chat",
				content: "Helloooooo!",
			});
		});

		this.addRibbonIcon("paper-plane", "Send file", async () => {
			if (!this.activeWriter) {
				new Notice("Not connected to server.");
				console.info("[OPV] No active writer found.");
				return;
			}

			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("Open a file to send it!");
				console.info("[OPV] Active file is not a TFile.");
				return;
			}

			await sendFileChunked(
				this.activeWriter,
				this.settings.channelName,
				activeFile,
				this.app
			);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, defaultSettings, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		console.info("[OPV] Unloading...");
	}
}

class vaultSettingsTab extends PluginSettingTab {
	plugin: OpVaultPlugin;

	constructor(app: App, plugin: OpVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Settings" });

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("The server address of the WebTransport server.")
			.addText((text) =>
				text
					.setPlaceholder("https://localhost:4433")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Channel Name")
			.setDesc("The channel room ID to connect to.")
			.addText((text) =>
				text
					.setPlaceholder("vault-1")
					.setValue(this.plugin.settings.channelName)
					.onChange(async (value) => {
						this.plugin.settings.channelName = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Encryption Key")
			.setDesc("Temporary encryption where no PIN is required.")
			.addText((text) =>
				text
					.setPlaceholder("super-secret-key-1234")
					.setValue(this.plugin.settings.encryptionKey)
					.onChange(async (value) => {
						this.plugin.settings.encryptionKey = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
