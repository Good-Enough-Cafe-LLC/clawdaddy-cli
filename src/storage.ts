import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { PairedHost } from './types';

const CONFIG_DIR = path.join(os.homedir(), '.clawdaddy');
export const CLIENT_ID_FILE = path.join(CONFIG_DIR, 'client-id.json');
export const PAIRING_FILE = path.join(CONFIG_DIR, 'paired.json');

/**
 * Ensures the configuration directory exists.
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Reads the persisted client ID from disk, or generates and saves a new one.
 */
export function getOrCreateClientId(): string {
  try {
    if (fs.existsSync(CLIENT_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLIENT_ID_FILE, 'utf-8'));
      if (data.clientId) return data.clientId;
    }
  } catch {
    // Fall through to generate a new ID
  }

  const clientId = `client-${randomBytes(4).toString('hex')}`;

  try {
    ensureConfigDir(); // Make sure .clawdaddy exists before writing
    fs.writeFileSync(CLIENT_ID_FILE, JSON.stringify({ clientId }, null, 2));
  } catch (e) {
    console.warn('⚠️ Failed to save client ID:', (e as Error).message);
  }

  return clientId;
}

/**
 * Loads paired hosts from disk into the provided Map.
 * All hosts are marked as disconnected on load.
 */
export function loadPairedHosts(pairedHosts: Map<string, PairedHost>): void {
  try {
    if (fs.existsSync(PAIRING_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const p of data as PairedHost[]) {
          pairedHosts.set(p.id, { ...p, connected: false });
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to load paired hosts:', (e as Error).message);
  }
}

/**
 * Persists the current paired hosts map to disk.
 */
export function savePairedHosts(pairedHosts: Map<string, PairedHost>): void {
  try {
    ensureConfigDir(); // Make sure .clawdaddy exists before writing
    fs.writeFileSync(PAIRING_FILE, JSON.stringify(Array.from(pairedHosts.values()), null, 2));
  } catch (e) {
    console.warn('⚠️ Failed to save paired hosts:', (e as Error).message);
  }
}