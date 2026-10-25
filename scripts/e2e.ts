import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../config/load';

/**
 * npm run test:e2e [-- --keep]
 * The e2e stage only exists while tests run: deploy it, run both E2E projects, then always tear
 * it down (unless --keep), and exit with the test result.
 */
const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false }, stage: { type: 'string', default: 'e2e' } } });
const stage = values.stage!;
const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

let status = run('npm', ['run', 'deploy', '--', '--stage', stage, '--yes']);
if (status === 0) {
  const env = { E2E_STAGE: stage };
  status = run('npx', ['vitest', 'run', '--project', 'e2e'], env);
  // Auto-pause switches receiving off for the stage, so it always runs last and on its own.
  const pause = run('npx', ['vitest', 'run', '--project', 'e2e-autopause'], env);
  status = status || pause;
}
if (!values.keep) {
  const teardown = run('npm', ['run', 'deploy', '--', '--stage', stage, '--destroy', '--yes']);
  if (teardown !== 0) console.error(`teardown of stage ${stage} failed; run: npm run deploy -- --stage ${stage} --destroy --yes`);
  status = status || teardown;
} else {
  console.log(`stage ${stage} kept (--keep); tear it down with: npm run deploy -- --stage ${stage} --destroy --yes`);
}
process.exit(status);
