import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, Metric, TreatMissingData, type IMetric } from 'aws-cdk-lib/aws-cloudwatch';
import { LambdaAction, SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { AttributeType, Billing, ProjectionType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { MxRecord, PublicHostedZone, TxtRecord, type IPublicHostedZone } from 'aws-cdk-lib/aws-route53';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { CfnReceiptRule, EmailIdentity, type Identity } from 'aws-cdk-lib/aws-ses';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription, SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { names, type InboxConfig, type StageConfig } from '../../config/schema';
import { API_ROUTE_KEYS } from '../../services/api/route-keys';
import { ACCOUNTS_BY_CREATED, ACCOUNTS_BY_SERVICE, BY_INDEXED_AT } from '../../services/shared/keys';
import type { ParserRoute } from '../../services/shared/types';
import type { StagePreflight } from './preflight-state';
import { nodeFunction } from './lambda';

export interface InboxStackProps extends StackProps {
  config: InboxConfig;
  stageName: string;
  stage: StageConfig;
  ruleSetName: string;
  preflight: StagePreflight;
}

const INGEST_TIMEOUT_SECONDS = 120;
/** Lambda caps all environment variables of one function at 4 KB. */
const ENV_BUDGET_BYTES = 3500;

/** One receiving stage: storage, the receipt rule, the processing pipeline, the API, and its alarms. */
export class InboxStack extends Stack {
  constructor(scope: Construct, id: string, props: InboxStackProps) {
    super(scope, id, props);
    const { config, stage, stageName, ruleSetName } = props;
    const n = names(config, stageName);
    const destroy = stage.removalPolicy === 'destroy';
    const removalPolicy = destroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const ruleArn = this.formatArn({
      service: 'ses',
      resource: 'receipt-rule-set',
      resourceName: `${ruleSetName}:receipt-rule/${n.ruleName}`,
    });
    const sesSource = {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: { 'aws:SourceArn': ruleArn },
    };

    // ---- storage ------------------------------------------------------------------------

    // S3 lifecycle works in whole days; the API hides mail at `retentionHours` exactly.
    const retentionDays = Math.max(1, Math.ceil(stage.retentionHours / 24));
    const bucket = new Bucket(this, 'Mail', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: destroy,
      lifecycleRules: [
        ...['raw/', 'messages/', 'attachments/'].map((prefix) => ({
          id: `expire-${prefix.slice(0, -1)}`,
          prefix,
          expiration: Duration.days(retentionDays),
          noncurrentVersionExpiration: Duration.days(1),
        })),
        {
          id: 'cleanup',
          noncurrentVersionExpiration: Duration.days(1),
          expiredObjectDeleteMarker: true,
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
    bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowSesToStoreRawMail',
        principals: [new ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('raw/*')],
        conditions: sesSource,
      }),
    );

    const table = new TableV2(this, 'Index', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      localSecondaryIndexes: [
        { indexName: BY_INDEXED_AT, sortKey: { name: 'ix', type: AttributeType.STRING }, projectionType: ProjectionType.ALL },
      ],
      // No point-in-time recovery: the table is an index that `inbox reindex` rebuilds from S3.
      deletionProtection: !destroy,
      removalPolicy,
    });

    // Accounts are entered by hand and cannot be rebuilt from mail, so they get backups and never expire.
    const accounts = new TableV2(this, 'Accounts', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: ACCOUNTS_BY_SERVICE,
          partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
        },
        {
          indexName: ACCOUNTS_BY_CREATED,
          partitionKey: { name: 'gsi2pk', type: AttributeType.STRING },
          sortKey: { name: 'gsi2sk', type: AttributeType.STRING },
        },
      ],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: !destroy,
      removalPolicy,
    });

    // ---- queue --------------------------------------------------------------------------

    const inbound = new Topic(this, 'Inbound', { displayName: `ses-inbox ${stageName} inbound` });
    inbound.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowSesToPublish',
        principals: [new ServicePrincipal('ses.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [inbound.topicArn],
        conditions: sesSource,
      }),
    );

    const ingestDlq = new Queue(this, 'IngestDlq', {
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const ingestQueue = new Queue(this, 'IngestQueue', {
      visibilityTimeout: Duration.seconds(INGEST_TIMEOUT_SECONDS * 6),
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: ingestDlq, maxReceiveCount: 5 },
    });
    inbound.addSubscription(new SqsSubscription(ingestQueue, { rawMessageDelivery: true }));

    // ---- functions ----------------------------------------------------------------------

    const routes: ParserRoute[] = stage.parsers.map((p) => ({
      name: p.name,
      module: p.module,
      timeoutSeconds: p.timeoutSeconds,
      match: p.match,
      requireDmarcForFrom: p.requireDmarcForFrom,
      skipSpam: p.skipSpam,
    }));
    assertEnvFits(routes);
    const common = {
      BUCKET: bucket.bucketName,
      TABLE: table.tableName,
      DOMAINS: JSON.stringify(stage.domains),
      PARSERS: JSON.stringify(routes),
    };

    // One invocation per message: store, index, then run the parser modules in worker threads.
    const ingest = nodeFunction(this, 'IngestFn', {
      entry: 'services/ingest/handler.ts',
      memoryMb: 1024,
      timeoutSeconds: INGEST_TIMEOUT_SECONDS,
      description: `ses-inbox ${stageName}: store, index, and parse received mail`,
      environment: {
        ...common,
        RETENTION_HOURS: String(stage.retentionHours),
        ...(stage.addressAllowlist ? { ADDRESS_ALLOWLIST: JSON.stringify(stage.addressAllowlist) } : {}),
      },
    });
    // Read: raw mail, and parsed content and attachments (reparse, and presigned URLs for parsers).
    bucket.grantRead(ingest);
    bucket.grantDelete(ingest, 'raw/*');
    bucket.grantPut(ingest, 'messages/*');
    bucket.grantPut(ingest, 'attachments/*');
    table.grantReadWriteData(ingest);
    ingest.addEventSource(
      new SqsEventSource(ingestQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
        maxConcurrency: stage.ingest.maxConcurrency,
      }),
    );

    const api = nodeFunction(this, 'ApiFn', {
      entry: 'services/api/handler.ts',
      memoryMb: 512,
      timeoutSeconds: 29,
      description: `ses-inbox ${stageName}: HTTP API`,
      environment: { ...common, INGEST_QUEUE_URL: ingestQueue.queueUrl, TOKEN_CACHE_SECONDS: String(stage.api.tokenCacheSeconds) },
    });
    bucket.grantRead(api);
    bucket.grantDelete(api);
    table.grantReadWriteData(api);
    ingestQueue.grantSendMessages(api);

    const httpApi = new HttpApi(this, 'Api', {
      apiName: `${config.project}-${stageName}`,
      createDefaultStage: false,
    });
    const apiStage = new HttpStage(this, 'ApiStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: stage.api.rateLimit, burstLimit: stage.api.burstLimit },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', api);
    for (const key of API_ROUTE_KEYS) {
      const [method, path] = key.split(' ') as [keyof typeof HttpMethod, string];
      httpApi.addRoutes({ path, methods: [HttpMethod[method]], integration });
    }

    // ---- receiving ----------------------------------------------------------------------

    const zone = this.hostedZone(stage, props.preflight);
    const identities: EmailIdentity[] = [];
    for (const domain of stage.domains) {
      if (stage.manageIdentity) {
        const identity: Identity = { value: domain, hostedZone: zone };
        const emailIdentity = new EmailIdentity(this, `Identity-${domain}`, { identity });
        identities.push(emailIdentity);
        if (!zone) {
          emailIdentity.dkimRecords.forEach((r, i) => {
            new CfnOutput(this, `DkimRecord${i + 1}-${domain.replace(/\W/g, '-')}`, {
              description: `CNAME to add for ${domain}`,
              value: `${r.name} CNAME ${r.value}`,
            });
          });
        }
      }
      if (zone) {
        new MxRecord(this, `Mx-${domain}`, {
          zone,
          recordName: `${domain}.`,
          values: [{ priority: 10, hostName: `inbound-smtp.${this.region}.amazonaws.com` }],
          ttl: Duration.minutes(5),
        });
        if (stage.dmarc !== 'off') {
          new TxtRecord(this, `Dmarc-${domain}`, {
            zone,
            recordName: `_dmarc.${domain}.`,
            values: [`v=DMARC1; p=${stage.dmarc}`],
            ttl: Duration.minutes(5),
          });
        }
      } else {
        new CfnOutput(this, `MxRecord-${domain.replace(/\W/g, '-')}`, {
          description: `MX record to add for ${domain}`,
          value: `${domain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
        });
      }
    }

    const rule = new CfnReceiptRule(this, 'ReceiptRule', {
      ruleSetName,
      rule: {
        name: n.ruleName,
        enabled: props.preflight.ruleEnabled,
        // The API and CloudFormation default this to false; without it there are no spam/virus verdicts.
        scanEnabled: true,
        tlsPolicy: 'Optional',
        // Always explicit: an empty list would match every verified domain in the account.
        recipients: stage.domains,
        actions: [{ s3Action: { bucketName: bucket.bucketName, objectKeyPrefix: 'raw/', topicArn: inbound.topicArn } }],
      },
    });
    // SES checks it can write to the bucket and publish to the topic when the rule is created.
    rule.node.addDependency(bucket, inbound, ...identities);

    // ---- alarms and auto-pause ----------------------------------------------------------

    const alerts = new Topic(this, 'Alerts', { displayName: `ses-inbox ${stageName} alerts` });
    alerts.addSubscription(new EmailSubscription(config.alertEmail));
    const notify = new SnsAction(alerts);

    const breaker = nodeFunction(this, 'BreakerFn', {
      entry: 'services/breaker/handler.ts',
      memoryMb: 256,
      timeoutSeconds: 30,
      description: `ses-inbox ${stageName}: auto-pause receiving on volume spikes`,
      environment: {
        STAGE: stageName,
        TABLE: table.tableName,
        RULE_SET_NAME: ruleSetName,
        RULE_NAME: n.ruleName,
        ALERTS_TOPIC_ARN: alerts.topicArn,
      },
    });
    // SES receipt-rule APIs do not support resource-level permissions.
    breaker.addToRolePolicy(
      new PolicyStatement({ actions: ['ses:DescribeReceiptRule', 'ses:UpdateReceiptRule'], resources: ['*'] }),
    );
    table.grantWriteData(breaker);
    alerts.grantPublish(breaker);

    // SES's own count of messages this rule accepted: exactly what gets billed.
    const received = (period: Duration) =>
      new Metric({
        namespace: 'AWS/SES',
        metricName: 'Received',
        dimensionsMap: { RuleName: n.ruleName },
        statistic: 'Sum',
        period,
      });
    const pauseAction = new LambdaAction(breaker, { useUniquePermissionId: true });
    for (const [alarmName, period, threshold] of [
      [n.hourlyAlarm, Duration.hours(1), stage.autoPause.perHour],
      [n.dailyAlarm, Duration.days(1), stage.autoPause.perDay],
    ] as const) {
      const alarm = new Alarm(this, alarmName, {
        alarmName,
        alarmDescription: `Auto-pause: more than ${threshold} messages accepted per ${period.toHumanString()}`,
        metric: received(period),
        threshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(pauseAction, notify);
    }

    const alarm = (id: string, description: string, metric: IMetric, threshold: number) =>
      new Alarm(this, id, {
        alarmName: `${n.alarmPrefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    // Four alarms per stage (two above are auto-pause) keep prod inside CloudWatch's 10 free alarms.
    // A stuck message ends up in the DLQ, and SES publish failures precede any expiry.
    const fiveMinutes = { period: Duration.minutes(5), statistic: 'Maximum' };
    alarm('ingest-dlq', 'Messages failed ingest 5 times and are parked in the ingest DLQ', ingestDlq.metricApproximateNumberOfMessagesVisible(fiveMinutes), 0);
    alarm(
      'ses-publishfailure',
      'SES could not run the receipt rule actions (PublishFailure)',
      new Metric({ namespace: 'AWS/SES', metricName: 'PublishFailure', dimensionsMap: { RuleName: n.ruleName }, statistic: 'Sum', period: Duration.minutes(5) }),
      0,
    );

    // ---- outputs (read by the CLI and the E2E tests) ------------------------------------

    const outputs: Record<string, string> = {
      ApiUrl: apiStage.url,
      BucketName: bucket.bucketName,
      TableName: table.tableName,
      AccountsTableName: accounts.tableName,
      IngestQueueUrl: ingestQueue.queueUrl,
      IngestDlqUrl: ingestDlq.queueUrl,
      RuleSetName: ruleSetName,
      RuleName: n.ruleName,
      HourlyAlarmName: n.hourlyAlarm,
      DailyAlarmName: n.dailyAlarm,
      AlertsTopicArn: alerts.topicArn,
      Domains: stage.domains.join(','),
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }

  private hostedZone(stage: StageConfig, preflight: StagePreflight): IPublicHostedZone | undefined {
    if (!stage.hostedZone) return undefined;
    const hostedZoneId = stage.hostedZone.hostedZoneId ?? preflight.hostedZoneId;
    if (!hostedZoneId) throw new Error(`no hosted zone id for ${stage.hostedZone.zoneName}; rerun preflight`);
    return PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName: stage.hostedZone.zoneName });
  }
}

function assertEnvFits(routes: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(routes));
  if (bytes > ENV_BUDGET_BYTES) {
    throw new Error(
      `The parser routing table is about ${bytes} bytes, but Lambda environment variables are capped at 4 KB. ` +
        `Use fewer or shorter parser rules.`,
    );
  }
}
