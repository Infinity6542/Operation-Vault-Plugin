import { Plugin, Notice } from 'obsidian';
import { connectToServer, sendJSON } from './transport';

const hash = "sCeCUgLb41xsgWA0+YHPbuwchl2mowfXS+ntOnSfIXE=";
const channel = "vault-1"

export default class OpVaultPlugin extends Plugin {
  activeWriter: any = null;

  async onload() {
    console.log('Loading client...');

    this.addRibbonIcon('dice', 'Test connection', async () => {
      new Notice('Trying connection...');
      this.activeWriter = await connectToServer(hash, channel);
    })

    this.addRibbonIcon('paper-plane', 'Broadcast', async () => {
      if (!this.activeWriter) {
        new Notice('Not connected to server.');
        console.log('No active writer found.');
        return;
      }
      new Notice('Broadcasting message...');
      await sendJSON(this.activeWriter, {
        type: "message",
        channel_id: channel,
        payload: "Helloooooo!"
      });
  })
}

  onunload() {
    console.log("Unloading...");
  }
}
