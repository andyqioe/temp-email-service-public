import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Per-user CLI settings: where each stage's API lives and which token to use. Never committed. */
export interface LocalConfig {
  defaultStage?: string;
  stages: Record<string, { apiUrl: string; token: string; domains?: string[] }>;
}

export const LOCAL_CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'ses-inbox',
  'config.json',
);

export function validateApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid API URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('API URL requires HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

function rejectSymlinks(): void {
  let current = LOCAL_CONFIG_FILE;
  while (current !== path.dirname(path.dirname(LOCAL_CONFIG_FILE))) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Credential path must not contain symlinks.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = path.dirname(current);
  }
}

export function readLocalConfig(): LocalConfig {
  rejectSymlinks();
  let text: string;
  try { text = fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stages: {} };
    throw new Error('Cannot read local credentials.', { cause: error });
  }
  try {
    const value = JSON.parse(text) as LocalConfig;
    if (!value || !value.stages || typeof value.stages !== 'object' || Array.isArray(value.stages)) throw new Error();
    if (value.defaultStage !== undefined && typeof value.defaultStage !== 'string') throw new Error();
    for (const entry of Object.values(value.stages)) {
      if (!entry || typeof entry.apiUrl !== 'string' || typeof entry.token !== 'string' || !entry.token.trim() || /[\r\n]/.test(entry.token)) throw new Error();
      validateApiUrl(entry.apiUrl);
      if (entry.domains !== undefined && (!Array.isArray(entry.domains) || entry.domains.some((d) => typeof d !== 'string'))) throw new Error();
    }
    return value;
  } catch { throw new Error('Invalid local credentials file; repair or remove it explicitly.'); }
}

export function saveStageCredentials(stage: string, entry: { apiUrl: string; token: string; domains?: string[] }): void {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(stage)) throw new Error('Invalid stage name.');
  if (!entry.token.trim() || /[\r\n]/.test(entry.token)) throw new Error('Invalid API token.');
  const config = readLocalConfig();
  config.stages[stage] = { ...entry, apiUrl: validateApiUrl(entry.apiUrl) };
  config.defaultStage ??= stage;
  const dir = path.dirname(LOCAL_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  rejectSymlinks();
  fs.chmodSync(dir, 0o700);
  const temp = fs.mkdtempSync(path.join(dir, '.save-'));
  try {
    const file = path.join(temp, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(file, LOCAL_CONFIG_FILE);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export interface ApiTarget {
  stage: string;
  apiUrl: string;
  token: string;
  domains: string[];
}

/** INBOX_API_URL / INBOX_TOKEN override the file, so automation can run without it. */
export function resolveApiTarget(stageFlag?: string): ApiTarget {
  const local = readLocalConfig();
  const stage = stageFlag ?? process.env.INBOX_STAGE ?? local.defaultStage ?? 'prod';
  const saved = local.stages[stage];
  const apiUrl = process.env.INBOX_API_URL ?? saved?.apiUrl;
  const token = process.env.INBOX_TOKEN ?? saved?.token;
  if (!apiUrl || !token) {
    throw new Error(
      `No API credentials for stage "${stage}". Run \`qmail setup --stage ${stage}\`, ` +
        `or set INBOX_API_URL and INBOX_TOKEN.`,
    );
  }
  const domains = process.env.INBOX_DOMAINS?.split(',').filter(Boolean) ?? saved?.domains ?? [];
  return { stage, apiUrl: validateApiUrl(apiUrl), token, domains };
}
