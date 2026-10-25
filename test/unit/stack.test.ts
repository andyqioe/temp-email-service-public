import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config/schema';
import { InboxStack } from '../../infra/lib/inbox-stack';
import { SharedStack } from '../../infra/lib/shared-stack';

const config = parseConfig({
  region: 'us-east-1',
  alertEmail: 'ops@example.com',
  monthlyBudgetUsd: 10,
  stages: {
    prod: {
      domains: ['in.example.com'],
      hostedZone: { zoneName: 'example.com', hostedZoneId: 'Z123' },
      dmarc: 'reject',
      parsers: [{ name: 'otp', module: 'otp' }],
    },
  },
});
const env = { account: '123456789012', region: 'us-east-1' };

function synth(ruleEnabled: boolean) {
  const app = new App();
  const stack = new InboxStack(app, 'SesInbox-prod', {
    env,
    config,
    stageName: 'prod',
    stage: config.stages.prod!,
    ruleSetName: 'ses-inbox-rules',
    preflight: { ruleEnabled },
  });
  return Template.fromStack(stack);
}

describe('InboxStack', () => {
  let t: Template;
  beforeAll(() => {
    t = synth(true);
  }, 120_000);

  it('creates an explicit, scanning receipt rule that stores to S3 and notifies SNS', () => {
    t.hasResourceProperties('AWS::SES::ReceiptRule', {
      RuleSetName: 'ses-inbox-rules',
      Rule: {
        Name: 'ses-inbox-prod',
        Enabled: true,
        ScanEnabled: true,
        Recipients: ['in.example.com'],
        Actions: [{ S3Action: Match.objectLike({ ObjectKeyPrefix: 'raw/', TopicArn: Match.anyValue() }) }],
      },
    });
  });

  it('keeps a paused rule paused across deploys', () => {
    synth(false).hasResourceProperties('AWS::SES::ReceiptRule', { Rule: Match.objectLike({ Enabled: false }) });
  });

  it('lets SES write only raw/ and only from this rule', () => {
    const [policy] = Object.values(t.findResources('AWS::S3::BucketPolicy'));
    const statement = (policy!.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>).find(
      (s) => s.Sid === 'AllowSesToStoreRawMail',
    );
    expect(statement).toMatchObject({
      Principal: { Service: 'ses.amazonaws.com' },
      Action: 's3:PutObject',
      Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
    });
    expect(JSON.stringify(statement!.Resource)).toContain('/raw/*');
    expect(JSON.stringify(statement!.Condition)).toContain('receipt-rule-set/ses-inbox-rules:receipt-rule/ses-inbox-prod');
  });

  it('publishes MX and DMARC records for the receiving domain', () => {
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'in.example.com.', Type: 'MX', ResourceRecords: ['10 inbound-smtp.us-east-1.amazonaws.com'] });
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: '_dmarc.in.example.com.', Type: 'TXT', ResourceRecords: ['"v=DMARC1; p=reject"'] });
  });

  it('retains data and has the indexed-at LSI', () => {
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      LocalSecondaryIndexes: [Match.objectLike({ IndexName: 'byIndexedAt' })],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('wires both auto-pause alarms to the breaker on the SES Received metric', () => {
    for (const [name, period] of [['ses-inbox-prod-autopause-hourly', 3600], ['ses-inbox-prod-autopause-daily', 86400]] as const) {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: name,
        Namespace: 'AWS/SES',
        MetricName: 'Received',
        Dimensions: [{ Name: 'RuleName', Value: 'ses-inbox-prod' }],
        Period: period,
        AlarmActions: Match.arrayWith([{ 'Fn::GetAtt': [Match.stringLikeRegexp('^BreakerFn'), 'Arn'] }]),
      });
    }
  });

  it('runs exactly three lean functions on arm64 Node 24: ingest (1 GB, one record at a time), API, breaker', () => {
    const fns = Object.entries(t.findResources('AWS::Lambda::Function'));
    expect(fns.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual(['ApiFn', 'BreakerFn', 'IngestFn']);
    for (const [, fn] of fns) expect(fn.Properties).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'] });
    expect(fns.find(([id]) => id.startsWith('IngestFn'))![1].Properties.MemorySize).toBe(1024);
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1, ScalingConfig: { MaximumConcurrency: 4 } });
  });

  it('has no parse queue: one ingest queue and its DLQ', () => {
    t.resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('expires mail after a day (S3 lifecycle) and indexes with TTL', () => {
    const [bucket] = Object.values(t.findResources('AWS::S3::Bucket'));
    const rules = bucket!.Properties.LifecycleConfiguration.Rules as Array<Record<string, unknown>>;
    for (const prefix of ['raw/', 'messages/', 'attachments/']) {
      expect(rules).toContainEqual(expect.objectContaining({ Prefix: prefix, ExpirationInDays: 1, Status: 'Enabled' }));
    }
  });

  it('keeps accounts in a separate, backed-up table indexed by service and by creation time', () => {
    t.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        GlobalSecondaryIndexes: [
          Match.objectLike({ IndexName: 'byService', KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }] }),
          Match.objectLike({ IndexName: 'byCreated', KeySchema: [{ AttributeName: 'gsi2pk', KeyType: 'HASH' }, { AttributeName: 'gsi2sk', KeyType: 'RANGE' }] }),
        ],
        Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
      }),
    });
  });

  it('lets ingest read stored content (reparse, presigned URLs for parsers)', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    const ingestPolicy = Object.entries(t.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('IngestFnServiceRoleDefaultPolicy'))!;
    expect(JSON.stringify(ingestPolicy[1])).toMatch(/s3:GetObject/);
    expect(policies).not.toMatch(/lambda:InvokeFunction/);
  });

  it('has four alarms: ingest DLQ, SES publish failure, and the two auto-pause alarms', () => {
    t.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  it('keeps the logical IDs of stateful resources stable (a change would replace them)', () => {
    const ids = Object.keys(t.toJSON().Resources);
    for (const id of ['Mail6A3D1F64', 'Index4A79713B', 'AccountsBE8A900E', 'IngestQueue2280FF4E', 'IngestDlqAD9CBE6D', 'InboundADA8BFE6', 'ReceiptRule']) {
      expect(ids).toContain(id);
    }
  });
});

describe('SharedStack', () => {
  it('creates and activates the rule set only when it owns it', () => {
    const owned = Template.fromStack(new SharedStack(new App(), 'S', { env, config, ownRuleSet: true }));
    owned.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    owned.hasResourceProperties('AWS::CloudFormation::CustomResource', { RuleSetName: 'ses-inbox-rules' });
    owned.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' } }) });

    const borrowed = Template.fromStack(new SharedStack(new App(), 'S', { env, config, ownRuleSet: false }));
    borrowed.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
  });
});
