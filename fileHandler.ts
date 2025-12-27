import { App, TFile, Notice} from 'obsidian';
import { sendSecureMessage } from './transport';

function arrayBufferTobase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function generateFileId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export async function sendFileChunked(writer: any, channel: string, file: TFile, app: App) {
  const chunkSize = 64 * 1024; // 64KB

  try {
    const arrayBuffer = await app.vault.readBinary(file);
    const totalBytes = arrayBuffer.byteLength;
    const fileId = generateFileId();
    const totalChunks = Math.ceil(totalBytes / chunkSize);

    // ol' reliable
    // new Notice(`Starting upload for ${file.name} (${totalBytes / 1024} KB).`);
    const progress = new Notice(`Preparing ${file.name}...`, 300000);
    console.log(`Beginning to send ${file.name} (${totalBytes}:${totalChunks}).`);
    
    // Let server now file incoming
    await sendSecureMessage(writer, channel, {
      type: "file_start",
      content: "",
      filename: file.name,
      fileId: fileId,
    });

    let offset = 0;
    let chunkIndex = 0;
    let lastPercent = 0;

    while (offset < totalBytes) {
      const slice = arrayBuffer.slice(offset, offset + chunkSize);
      const base64Chunk = arrayBufferTobase64(slice);

      await sendSecureMessage(writer, channel, {
        type: "file_chunk",
        content: base64Chunk,
        fileId: fileId,
        chunkIndex: chunkIndex
      });

      offset += chunkSize;
      chunkIndex++;

      // Update progress
      const percentage = Math.floor((chunkIndex / totalChunks) * 100);
      console.log(`Sending ${file.name} (${chunkIndex}/${totalChunks}) - ${percentage}%`);

      if (percentage > lastPercent) {
        progress.setMessage(`Uploading ${file.name}: ${percentage}%`);
        lastPercent = percentage;
      }

      if (chunkIndex % 5 === 0) await new Promise(r => setTimeout(r, 10));
    }
    
    // Transfer end notice
    await sendSecureMessage(writer, channel, {
      type: "file_end",
      content: "",
      fileId: fileId,
      filename: file.name
    });
    console.log(`Finished sending ${file.name}.`);

    progress.setMessage(`File ${file.name} was sent.`);

    setTimeout(() => {
      progress.hide();
    }, 3000);
  } catch (e) {
    console.error("Error sending file in chunks:", e);
    new Notice(`Error while sending file: ${e.message}`);
  }
}
