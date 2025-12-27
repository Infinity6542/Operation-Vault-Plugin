import { Notice } from 'obsidian';

interface Message {
  type: "join" | "message";
  channel_id: string;
  payload: string;
}

export async function connectToServer(serverHash: string, channelID: string) {
  const url = "https://127.0.0.1:8080/ws";

  const options: any = {
    serverCertificateHashes: [
      { algorithm: "sha-256", value: conversion(serverHash) }
    ]
  };

  try {
    const transport = new WebTransport(url, options);
    console.log("Attempting a connection to " + url);
    await transport.ready;
    new Notice("Connected to the server.");
    console.log("WebTransport connection successful.");

    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const joinMsg: Message = {
      type: "join",
      channel_id: channelID,
      payload: "Hi!"
    };
    await sendJSON(writer, joinMsg);
    new Notice(`Joined the channel ${channelID}.`);

    readLoop(reader);
    return writer;
  } catch (e) {
    console.error("Something went wrong", e);
    new Notice("something went wrong.");
    return null
  }
}
export async function sendJSON(writer: any, msg: Message) {
  const jsonString = JSON.stringify(msg);
  const encoder = new TextEncoder();
  const data = encoder.encode(jsonString);
  await writer.write(data);
}

async function readLoop(reader: any) {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        console.log("Stream closed");
        break;
      }
      const message = decoder.decode(value, { stream: true });
      console.log("Received message:", message);

      try {
        const msg = JSON.parse(message);
        if (msg.type === "message") {
          new Notice(`New message in channel ${msg.channel_id}: ${msg.content}`);
        }
      } catch (e) {
        console.error("Error parsing message JSON", e);
      }
    }
  } catch (e) {
      console.error("Error reading from stream. It's probably closed, but just in case it isn't: ", e);
  }
}

function conversion(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

