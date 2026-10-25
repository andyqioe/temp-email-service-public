import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load';
import { ensureAwsSession, useProfile } from '../cli/aws-session';
import { readLocalConfig } from '../cli/local-config';
import { preflight } from '../cli/preflight';

/**
 * npm run preflight -- [--stage <stage>] [--profile <p>]
 * Checks the AWS account and records live state for CDK. `npm run deploy` runs this itself;
 * run it by hand before `npx cdk diff`.
 */
const { values } = parseArgs({ options: { stage: { type: 'string' }, profile: { type: 'string' } } });
const stageName = values.stage ?? process.env.INBOX_STAGE ?? readLocalConfig().defaultStage ?? 'prod';
const config = await loadConfig();
await ensureAwsSession(config.region, useProfile(values.profile, config.awsProfile));
const { notes } = await preflight(stageName);
for (const note of notes) console.log(`- ${note}`);
