import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export interface AwsIdentity {
  account: string;
  arn: string;
  profile?: string;
}

/**
 * Chooses the AWS profile (--profile, then AWS_PROFILE, then `awsProfile` from inbox.config.ts)
 * and exports it so every SDK client, and CDK subprocesses, use the same credentials.
 */
export function useProfile(flag: string | undefined, configProfile: string | undefined): string | undefined {
  const profile = flag ?? process.env.AWS_PROFILE ?? configProfile;
  if (profile) process.env.AWS_PROFILE = profile;
  return profile;
}

/**
 * Verifies the credentials work. When an SSO session is missing or expired and we are attached
 * to a terminal, offers to run `aws sso login` and retries once; otherwise explains what to run.
 */
export async function ensureAwsSession(region: string, profile: string | undefined): Promise<AwsIdentity> {
  for (let attempt = 0; ; attempt++) {
    try {
      // A fresh client re-reads the SSO token cache, so a login in between is picked up.
      const out = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
      return { account: out.Account!, arn: out.Arn!, profile };
    } catch (err) {
      const sso = profile !== undefined && isSsoProfile(profile);
      if (!sso || !looksLikeCredentialsError(err)) throw err;
      const command = `aws sso login --profile ${profile}`;
      if (attempt > 0 || !process.stdin.isTTY) {
        throw new Error(`AWS SSO session for profile "${profile}" is missing or expired. Run: ${command}`, { cause: err });
      }
      if (!(await confirm(`AWS SSO session for profile "${profile}" is missing or expired. Run \`${command}\` now? [Y/n] `))) {
        throw new Error(`Not logged in. Run: ${command}`, { cause: err });
      }
      const r = spawnSync('aws', ['sso', 'login', '--profile', profile], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`\`${command}\` failed`, { cause: err });
    }
  }
}

export function looksLikeCredentialsError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return (
    ['CredentialsProviderError', 'TokenProviderError', 'ExpiredToken', 'ExpiredTokenException', 'UnrecognizedClientException', 'InvalidClientTokenId'].includes(
      e.name ?? '',
    ) || /sso|expired|could not load credentials|token/i.test(e.message ?? '')
  );
}

/** True when ~/.aws/config defines the profile with IAM Identity Center (SSO) settings. */
export function isSsoProfile(profile: string, configFile = process.env.AWS_CONFIG_FILE ?? path.join(os.homedir(), '.aws', 'config')): boolean {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return false;
  }
  let inProfile = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      const name = header[1]!.trim();
      inProfile = name === `profile ${profile}` || (profile === 'default' && name === 'default');
      continue;
    }
    if (inProfile && /^\s*sso_(session|start_url)\s*=/.test(line)) return true;
  }
  return false;
}

/** Latest expiry among cached SSO access tokens, for display. */
export function ssoSessionExpiry(cacheDir = path.join(os.homedir(), '.aws', 'sso', 'cache')): Date | undefined {
  let latest: Date | undefined;
  try {
    for (const file of fs.readdirSync(cacheDir)) {
      if (!file.endsWith('.json')) continue;
      const data = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8')) as { accessToken?: string; expiresAt?: string };
      if (!data.accessToken || !data.expiresAt) continue;
      const at = new Date(data.expiresAt);
      if (!latest || at > latest) latest = at;
    }
  } catch {
    return undefined;
  }
  return latest;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
