# Operation Vault
Operation Vault (OV, OpVault) consists of three major components: an Obsidian client, web client and relay server. Both the web client and relay server are meant to be self-hostable, while the Obsidian will work after installation. The plugin must work in conjunction with the relay server.

The objective is to transform an Obsidian vault into something that has similar “cloud” capabilities to Google Docs. This means quick generation of links with minimal setup required on both ends of a connection. Oh, and did I mention that this will be (mostly) peer to peer? And end-to-end encrypted?

**THIS IS THE REPO FOR THE PLUGIN. THE MONOREPO CAN BE FOUND [HERE](https://github.com/Infinity6542/Operation-Vault)**
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

Want more features? Open a feature request as an issue and I’ll take a look into it!