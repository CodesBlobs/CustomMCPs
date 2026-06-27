import { PairingFileSchema, type PairingFile } from "@agentic-browser-mcp/shared";

import { PAIRING_STORAGE_KEY, type StoredPairingState } from "./internal.js";

export async function readStoredPairingState(): Promise<StoredPairingState | undefined> {
  const values = await chrome.storage.local.get(PAIRING_STORAGE_KEY);
  const storedValue = values[PAIRING_STORAGE_KEY] as StoredPairingState | undefined;
  if (!storedValue) {
    return undefined;
  }

  const pairingFile = PairingFileSchema.parse(storedValue.pairingFile);
  if (Date.parse(pairingFile.expiresAt) <= Date.now()) {
    await clearStoredPairing();
    return undefined;
  }

  return {
    pairingFile,
    importedAt: storedValue.importedAt,
  };
}

export async function readStoredPairingFile(): Promise<PairingFile | undefined> {
  const storedState = await readStoredPairingState();
  return storedState?.pairingFile;
}

export async function writeStoredPairingJson(rawPairingJson: string): Promise<StoredPairingState> {
  const parsed = JSON.parse(rawPairingJson) as unknown;
  const pairingFile = PairingFileSchema.parse(parsed);
  return await writeStoredPairingFile(pairingFile);
}

export async function writeStoredPairingFile(pairingFile: PairingFile): Promise<StoredPairingState> {
  const storedState: StoredPairingState = {
    pairingFile: PairingFileSchema.parse(pairingFile),
    importedAt: new Date().toISOString(),
  };

  await chrome.storage.local.set({
    [PAIRING_STORAGE_KEY]: storedState,
  });

  return storedState;
}

export async function clearStoredPairing(): Promise<void> {
  await chrome.storage.local.remove(PAIRING_STORAGE_KEY);
}
