const secret = "wow_really_cool_secret_444";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getKey() {
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("some_salt"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPacket(data: any): Promise<string> {
  const key = await getKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const jsonStr = JSON.stringify(data);

  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    key,
    encoder.encode(jsonStr)
  );

  const packageData = {
    iv: arrayBufferToBase64(iv.buffer),
    data: arrayBufferToBase64(encrypted)
  };

  return JSON.stringify(packageData);
}

export async function decryptPacket(payload: string): Promise<any> {
  try {
    const pkg = JSON.parse(payload);
    const key = await getKey();

    if (!pkg.iv || !pkg.data) {
      throw new Error("Invalid payload structure");
    }
    const iv = base64ToArrayBuffer(pkg.iv);
    const encryptedContent = base64ToArrayBuffer(pkg.data);

    const decryptedBytes = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      key,
      encryptedContent
    );

    const decryptedStr = decoder.decode(decryptedBytes);
    return JSON.parse(decryptedStr);
  } catch (e) {
    console.error("Decryption failed:", e);
    return null;
  }
}

// Helpers
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function getHash(input: ArrayBuffer): Promise<string> {
  // Input the binary
  // For files, use app.vault.readBinary(file) to get ArrayBuffer
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', input);

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}
