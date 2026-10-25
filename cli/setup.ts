import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createToken } from './admin';
import { useProfile } from './aws-session';
import { readLocalConfig, saveStageCredentials, validateApiUrl } from './local-config';
import { readLine, readSecret } from './prompt';

export interface SetupOptions {
  method?: 'existing' | 'aws';
  yes?: boolean;
  replace?: boolean;
  apiUrl?: string;
  region?: string;
  stack?: string;
  name?: string;
}

export async function setupCredentials(o: SetupOptions, stage: string, profile?: string): Promise<void> {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(stage)) throw new Error('Invalid stage name.');
  const saved = readLocalConfig().stages[stage];
  if (saved && !o.replace) {
    process.stderr.write('Credentials already saved; leaving unchanged. Use --replace to authorize replacement.\n');
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let method = o.method;
  if (!method) {
    if (!interactive) throw new Error('Run setup in a terminal, or provide --method existing|aws and --yes.');
    const answer = await readLine('Connection: existing token [1], AWS owner [2], or Enter to cancel: ');
    if (!answer.trim()) return;
    method = answer.trim() === '1' ? 'existing' : answer.trim() === '2' ? 'aws' : undefined;
    if (!method) throw new Error('Choose 1 or 2.');
  }
  if (!interactive && !o.yes) throw new Error('Unattended setup requires --yes.');
  if (method === 'existing') {
    if (o.stack || o.region || o.name) throw new Error('--stack, --region and --name require --method aws.');
    const apiUrl = validateApiUrl(o.apiUrl ?? process.env.INBOX_API_URL ?? (interactive ? await readLine('API URL: ') : ''));
    const token = process.env.INBOX_TOKEN ?? (interactive ? await readSecret() : '');
    if (!token) throw new Error('Provide INBOX_TOKEN or enter a token in a terminal.');
    if (!o.yes && !await confirm(`Save credentials for ${new URL(apiUrl).origin}? No request will be sent. [y/N] `)) return;
    saveStageCredentials(stage, { apiUrl, token });
  } else {
    if (o.apiUrl) throw new Error('--api-url requires --method existing.');
    const region = o.region ?? (interactive ? await readLine('AWS region: ') : '');
    const stack = o.stack ?? (interactive ? await readLine('Existing CloudFormation stack name: ') : '');
    const name = o.name ?? (interactive ? await readLine('New token name: ') : '');
    if (!region || !stack || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('AWS setup requires --region, --stack and --name (1-64 letters, digits, dots, underscores or hyphens).');
    if (!o.yes && !await confirm('Read the stack and register a deployment-wide mail token using your AWS identity? [y/N] ')) return;
    useProfile(profile, undefined);
    const cfn = new CloudFormationClient({ region });
    let outputs: Record<string, string>;
    try {
      const result = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
      outputs = Object.fromEntries((result.Stacks?.[0]?.Outputs ?? []).filter((v) => v.OutputKey && v.OutputValue).map((v) => [v.OutputKey!, v.OutputValue!]));
    } catch { throw new Error('Cannot read stack outputs. Check region, stack, AWS credentials and permissions.'); }
    finally { cfn.destroy(); }
    if (!outputs.ApiUrl || !outputs.TableName) throw new Error('Stack must expose ApiUrl and TableName outputs.');
    const apiUrl = validateApiUrl(outputs.ApiUrl);
    let token: string;
    try { token = await createToken({ region, outputs: { TableName: outputs.TableName } }, name); }
    catch { throw new Error('Token registration failed or its result is uncertain. Check the token registry before retrying.'); }
    try { saveStageCredentials(stage, { apiUrl, token, domains: outputs.Domains?.split(',').filter(Boolean) }); }
    catch { throw new Error('Token registered but local save failed. Revoke the named token in this stack before retrying.'); }
  }
  process.stderr.write('Saved API credentials locally. No AWS keys were saved.\n');
}

async function confirm(prompt: string): Promise<boolean> {
  return ['y', 'yes'].includes((await readLine(prompt)).trim().toLowerCase());
}
