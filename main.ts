import { Plugin, Notice } from 'obsidian';
import { connectToServer, sendSecureMessage } from './transport';
import { sendFileChunked } from './fileHandler';

interface settings {
  serverUrl: string;
  channelName: string;
  encryptionKey: string;
}

const defaultSettings: settings = {
  serverUrl: "ws://127.0.0.1:8080",
  channelName: "vault-1",
  encryptionKey: "wow-really-cool-secret-444",
}

const hash = "sCeCUgLb41xsgWA0+YHPbuwchl2mowfXS+ntOnSfIXE=";
const channel = "vault-1"

export default class OpVaultPlugin extends Plugin {
  activeWriter: any = null;

  async onload() {
    console.log('Loading client...');

    this.addRibbonIcon('dice', 'Test connection', async () => {
      new Notice('Trying connection...');
      this.activeWriter = await connectToServer(hash, channel, this.app);
    })

    this.addRibbonIcon('text', 'Chat', async () => {
      if (!this.activeWriter) {
        new Notice('Not connected to server.');
        console.log('No active writer found.');
        return;
      }
      new Notice('Broadcasting message...');
      await sendSecureMessage(this.activeWriter, channel, {
        type: "chat",
        content: "Helloooooo!"
      });
  })

  this.addRibbonIcon("paper-plane", "Send file", async () => {
    if (!this.activeWriter) {
      new Notice('Not connected to server.');
      console.log('No active writer found.');
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('Open a file to send it!');
      console.log('Active file is not a TFile.');
      return;
    }

    await sendFileChunked(this.activeWriter, channel, activeFile, this.app);
  })
}

  onunload() {
    console.log("Unloading...");
  }
}

class vaultSettingsTab {
}
