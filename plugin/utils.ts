import { App, TFile } from "obsidian";

export function getFile(app: App, path: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

export function getDate(ms?: number): string {
  let now: Date;
  if (ms) {
    now = new Date(ms);
  } else {
    now = new Date();
  }
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
