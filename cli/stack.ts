import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { loadConfig, stageOf } from '../config/load';
import { names, type InboxConfig, type StageConfig } from '../config/schema';

/** Everything the admin commands and E2E tests need to find a deployed stage. */
export interface StageOutputs {
  ApiUrl: string;
  BucketName: string;
  TableName: string;
  AccountsTableName: string;
  IngestQueueUrl: string;
  IngestDlqUrl: string;
  RuleSetName: string;
  RuleName: string;
  HourlyAlarmName: string;
  DailyAlarmName: string;
  AlertsTopicArn: string;
  Domains: string;
}

export interface StageContext {
  config: InboxConfig;
  stageName: string;
  stage: StageConfig;
  region: string;
  outputs: StageOutputs;
}

export async function stageContext(stageName: string): Promise<StageContext> {
  const config = await loadConfig();
  const stage = stageOf(config, stageName);
  const stackName = names(config, stageName).stackName;
  const cfn = new CloudFormationClient({ region: config.region });
  let outputs: Record<string, string>;
  try {
    const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
  } catch (err) {
    if ((err as { name?: string }).name === 'ValidationError') {
      throw new Error(`stack ${stackName} is not deployed; run \`npm run deploy -- --stage ${stageName}\``, { cause: err });
    }
    throw err;
  }
  return { config, stageName, stage, region: config.region, outputs: outputs as unknown as StageOutputs };
}
