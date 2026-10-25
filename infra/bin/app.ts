import { App } from 'aws-cdk-lib';
import { loadConfig, stageOf } from '../../config/load';
import { names, sharedStackName } from '../../config/schema';
import { InboxStack } from '../lib/inbox-stack';
import { readPreflight } from '../lib/preflight-state';
import { SharedStack } from '../lib/shared-stack';

const app = new App();
const config = await loadConfig();
const preflight = readPreflight();
if (preflight.region !== config.region) {
  throw new Error(`preflight ran for ${preflight.region} but inbox.config.ts says ${config.region}; rerun preflight`);
}
const env = { account: preflight.account, region: config.region };

const shared = new SharedStack(app, sharedStackName(config), {
  env,
  config,
  ownRuleSet: preflight.ruleSet.owned,
  description: 'ses-inbox: receipt rule set and budget shared by all stages',
});

// Synthesize only the stage being deployed (`-c stage=<name>`); preflight state is per stage.
const stageName = app.node.tryGetContext('stage') as string | undefined;
if (stageName) {
  const stage = stageOf(config, stageName);
  const stagePreflight = preflight.stages[stageName];
  if (!stagePreflight) throw new Error(`no preflight state for stage ${stageName}; rerun preflight`);
  const stack = new InboxStack(app, names(config, stageName).stackName, {
    env,
    config,
    stageName,
    stage,
    ruleSetName: preflight.ruleSet.name,
    preflight: stagePreflight,
    terminationProtection: stage.removalPolicy === 'retain',
    description: `ses-inbox stage ${stageName}: ${stage.domains.join(', ')}`,
  });
  stack.addStackDependency(shared);
}

app.synth();
