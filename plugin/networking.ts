import { TransportPacket, InnerMessage } from "./types";
import { encryptPacket } from "./crypto";
export async function joinChannel(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  channelId: string,
  senderId: string,
  nickname: string,
) {
  const packet: TransportPacket = {
    type: "join",
    channel_id: channelId,
    sender_id: senderId,
    nickname: nickname,
    payload: "Transfer room :D",
  };
  await sendRawJSON(writer, packet);
  console.debug(`[OPV] Joined transfer channel ${channelId}`);
}

export async function leaveChannel(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  channelId: string,
  senderId: string,
) {
  // No nickname as they can just tell from the senderId I think maybe idk yet :sob:
  const packet: TransportPacket = {
    type: "leave",
    channel_id: channelId,
    sender_id: senderId,
    payload: "Cya later :)",
  };
  await sendRawJSON(writer, packet);
  console.debug(`[OPV] Left transfer channel ${channelId}`);
}

export async function sendSecureMessage(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  channelId: string,
  senderId: string,
  innerData: InnerMessage,
  key: string,
) {
  const encryptedPayload = await encryptPacket(innerData, key);

  const packet: TransportPacket = {
    type: "message",
    channel_id: channelId,
    sender_id: senderId,
    payload: encryptedPayload,
  };

  await sendRawJSON(writer, packet);
}

export async function sendRawJSON(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  data:
    | TransportPacket
    | { type: string; channel_id: string; sender_id: string; payload: string },
) {
  try {
    // Too verbose for prod
    // console.debug("[DBG] [OPV] Sending JSON:", JSON.stringify(data));
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
  } catch (e) {
    const errorStr = String(e);
    if (errorStr.includes("aborted") || errorStr.includes("closed")) {
      console.debug("[OPV] Cannot send message, connection is closed");
      throw e;
    } else {
      console.error("[OPV] Error sending message:", e);
      throw e;
    }
  }
}
