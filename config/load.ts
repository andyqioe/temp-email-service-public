import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseConfig, type InboxConfig } from './schema';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

declare const QMAIL_PACKAGED: boolean;

/** Loads and validates inbox.config.ts (or the file named by INBOX_CONFIG). */
export async function loadConfig(file?: string): Promise<InboxConfig> {
  if (typeof QMAIL_PACKAGED !== 'undefined' && !file && !process.env.INBOX_CONFIG) {
    throw new Error('AWS commands and token setup require INBOX_CONFIG pointing to your deployment config (.json or .mjs). Mail commands only need an API URL and token.');
  }
  const target = path.resolve(file ?? process.env.INBOX_CONFIG ?? path.join(REPO_ROOT, 'inbox.config.ts'));
  if (target.endsWith('.json')) return parseConfig(JSON.parse(await fs.readFile(target, 'utf8')));
  const mod = (await import(pathToFileURL(target).href)) as { default?: unknown };
  if (mod.default === undefined) throw new Error(`${target} has no default export`);
  return parseConfig(mod.default);
}

export function stageOf(config: InboxConfig, stage: string) {
  const s = config.stages[stage];
  if (!s) throw new Error(`unknown stage "${stage}" (configured: ${Object.keys(config.stages).join(', ')})`);
  return s;
}
