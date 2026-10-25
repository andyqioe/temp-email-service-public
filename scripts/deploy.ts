import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig, REPO_ROOT, stageOf } from '../config/load';
import { names, sharedStackName } from '../config/schema';
import { ensureAwsSession, useProfile } from '../cli/aws-session';
import { preflight } from '../cli/preflight';

/**
 * npm run deploy -- --stage <stage> [--yes] [--synth-only] [--destroy]
 * Runs preflight (which records live account state), then CDK for the shared stack and the stage.
 */
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    yes: { type: 'boolean', default: false },
    'synth-only': { type: 'boolean', default: false },
    destroy: { type: 'boolean', default: false },
    profile: { type: 'string' },
  },
});
const stageName = values.stage ?? process.env.INBOX_STAGE;
if (!stageName) {
  console.error('usage: npm run deploy -- --stage <stage> [--yes] [--synth-only] [--destroy] [--profile <p>]');
  process.exit(2);
}
const config = await loadConfig();
const stage = stageOf(config, stageName);
const stageStack = names(config, stageName).stackName;
// Exported before anything talks to AWS, so the CDK subprocess uses the same profile.
const profile = useProfile(values.profile, config.awsProfile);
if (!values['synth-only']) await ensureAwsSession(config.region, profile);
const cdk = (args: string[]) => {
  const r = spawnSync('npx', ['cdk', ...args, '-c', `stage=${stageName}`], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!values['synth-only']) {
  const { notes, bootstrapped, state } = await preflight(stageName);
  for (const note of notes) console.log(`preflight: ${note}`);
  if (!bootstrapped && !values.destroy) cdk(['bootstrap', `aws://${state.account}/${state.region}`]);
}

if (values['synth-only']) {
  cdk(['synth', '--quiet']);
} else if (values.destroy) {
  if (stage.removalPolicy === 'retain') {
    console.error(`stage ${stageName} retains its data; destroy the stack from the CloudFormation console if you really mean it`);
    process.exit(2);
  }
  cdk(['destroy', stageStack, ...(values.yes ? ['--force'] : [])]);
} else {
  cdk(['deploy', sharedStackName(config), stageStack, ...(values.yes ? ['--require-approval', 'never'] : [])]);
  console.log(`
Deployed ${stageStack}. Next:
  1. Confirm the SNS subscription email sent to ${config.alertEmail} (alarms and auto-pause notices).
  2. Create an API token:   npm run qmail -- token create <name> --stage ${stageName} --save
  3. Send mail to any address @${stage.domains[0]} and run:   npm run qmail -- poll <address> --stage ${stageName}`);
}
