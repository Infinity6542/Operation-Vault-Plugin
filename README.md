# Operation Vault
Operation Vault (OV, OpVault) consists of three major components: an Obsidian client, web client and relay server. Both the web client and relay server are meant to be self-hostable, while the Obsidian will work after installation. The plugin must work in conjunction with the relay server.

The objective is to transform an Obsidian vault into something that has similar “cloud” capabilities to Google Docs. This means quick generation of links with minimal setup required on both ends of a connection. Oh, and did I mention that this will be (mostly) peer to peer? And end-to-end encrypted?

**THIS IS THE REPO FOR THE PLUGIN. THE MONOREPO CAN BE FOUND [HERE](https://github.com/Infinity6542/Operation-Vault)**
## Installation & Usage
### Installation
Want to use OpVault? That's epic! You can follow these steps:
1. OpVault is not yet publicly listed (coming soon!). For now, you can use [BRAT](https://github.com/TfTHacker/obsidian42-brat) and ensure it is installed and enabled.
2. Enter the options/settings for BRAT and add a new beta plugin.
3. Use `infinity6542/operation-vault-plugin` as the repository.
4. Select "Latest version".
5. Ensure "Enable after isntalling the plugin" is ticked and click on "Add plugin".
6. You're done!
> [!WARNING]
> While mobile is technically supported, it's a bit iffy at the moment. I've tested it and it's extremely inconsistent and awareness features aren't syupported. Rest assured, I'll nail down mobile support by v1.0.
### Usage
**If you are on mobile (Android/iOS), please see the above warning.**
Using Operation Vault is easy. Use these steps for sharing and downloading:
#### Sharing (single file)
1. Open the file that you want to share. This is optional, but it'll make the process easier.
2. Click on the "Share file" button on the far left ribbon. It'll appear as a link icon, probably near the bottom of the list.
3. The "File" field should be prefilled with the file you have open. Set up a PIN if you want, then press either "Create share link" (this will be slightly easier).
4. Send the link (or ID if you clicked "Create share" in step 3) to whoever you want to share the file with!

> [!WARNING]
> There may be issues with file contents not syncing upon first transfer. If this happens, simply trigger a sync update manually by editing the file.
#### Sharing (sync group)
1. Add the property "sync-group" to all the files you want to share and give them a name.
2. Click on the same "Share file" button as when sharing a singular file (see above step 2 if you need help).
3. Change "Share type" to "Sync group".
4. Enter the name you gave to the group in step 1 in "Group name".
5. Enter a PIN if you wish, then click either "Create group link" or "Create sync group".
6. Your link or ID will be copied to your clipboard. Simply paste and send it to someone!
#### Receiving (link)
1. Simply click on the link then click on "Get file" or "Get group", depending on the type. After that, you're done!
#### Receiving (ID)
1. Open Obsidian and click on the "Download shared item" button in the far left ribbon. It should be near the bottom of the list.
2. Depending on whether it's an individual file or share group, adjust "Share type" accordingly if necessary.
3. Copy then paste the share ID provided to you in "Share ID".
4. If provided one, enter a PIN.
5. Click on "Get file" or "Get group", depending on what you chose in step 1.
6. You're done! Enjoy collaborating :)
## Capabilities
### Multiplayer
OpVault will utilise a relayed P2P (peer-to-peer) system. Below is a good diagram of what’s happening:
```mermaid
flowchart LR
	A[Host 1 updates & processing]-->B[Relay server receive & dispatch]
	B-->C[Client receive & process updates]
```
Of course, it’s a lot more complicated than this. Hopefully there’ll be documentation at some stage as to what “processing” actually means, but the server also observes which clients it should forward the data to rather than blindly firing data at every device connected to it.

Anyway, multiplayer functionality will have these features:
- Live cursors (yay!)
- Native Obsidian collaboration
- Frictionless collaboration
	- No account registration required (yippee!)
	- Begin sharing in 1 click (generate link)
	- Begin collaborating in 2 clicks (click link + confirm nickname)
- Data encrypted with key pairs
- Ridiculously fast updates with minimal data transfer
- Simple web UI for non-Obsidian users
	- Comes with KaTeX, Excalidraw, Canvas, etc. rendering support!

### Hosting/CRM
I hope to implement a CRM-like systenm in the future. Please see the README for the web client under "Web Reader" for more information.

Want more features? Open a feature request as an issue and I’ll take a look into it!
