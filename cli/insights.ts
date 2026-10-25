import { DescribeBudgetCommand, BudgetsClient } from '@aws-sdk/client-budgets';
import { CloudFormationClient, paginateListStackResources } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { DescribeContinuousBackupsCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetAccountSettingsCommand, GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ListReceiptFiltersCommand, SESClient } from '@aws-sdk/client-ses';
import { GetAccountCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { names, sharedStackName } from '../config/schema';
import { ddbKeys, META } from '../services/shared/keys';
import { isReceiving } from '../services/shared/receiving';
import { ssoSessionExpiry, type AwsIdentity } from './aws-session';
import type { StageContext } from './stack';

/**
 * Read-only data behind `qmail usage`. Every section is fetched independently, so one
 * missing permission or metric never hides the others.
 */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export const RANGES = { '24h': 86_400, '7d': 7 * 86_400, '14d': 14 * 86_400 } as const;
export type RangeKey = keyof typeof RANGES;

export interface FunctionUsage {
  name: string;
  stack: string;
  runtime?: string;
  arch?: string;
  memoryMb?: number;
  timeoutS?: number;
  codeBytes?: number;
  invocations?: number;
  errors?: number;
  throttles?: number;
  p95Ms?: number;
  /** Deploy-time helpers (rule-set activation, e2e teardown), not part of the mail path. */
  helper?: boolean;
}

export interface UsageData {
  generatedAt: string;
  stage: string;
  region: string;
  range: RangeKey;
  header: Section<{ account: string; arn: string; profile?: string; ssoExpiresAt?: string }>;
  receiving: Section<{
    rule: string;
    ruleEnabled?: boolean;
    breaker: { paused: boolean; at?: string; by?: string; alarm?: string } | null;
    autoPause: { perHour: number; perDay: number };
    sesProduction: boolean;
    /** CIDRs blocked by this project's SES IP filters. */
    blockedIps: string[];
    received: number;
    series: number[];
    seriesUnit: 'hour' | 'day';
    publishFailures: number;
  }>;
  inboxes: Section<{ messages: number; addresses: number; retentionHours: number }>;
  accounts: Section<{ total: number; withPassword: number; byService: Array<{ service: string; count: number }> }>;
  parsers: Section<{
    rules: Array<{ name: string; module: string; match: string; timeoutS: number }>;
    runs: Record<string, { ok: number; error: number }>;
    runsNote?: string;
  }>;
  lambdas: Section<{ concurrencyLimit?: number; peakConcurrency?: number; functions: FunctionUsage[] }>;
  queue: Section<{ waiting: number; inFlight: number; dlq: number }>;
  storage: Section<{
    s3: { bytes?: number; objects?: number; asOf?: string };
    index: { items?: number; bytes?: number };
    accounts: { items?: number; bytes?: number; backups?: string };
  }>;
  api: Section<{ requests: number; errors4xx: number; errors5xx: number; p95Ms?: number }>;
  alarms: Section<Array<{ name: string; state: string }>>;
  cost: Section<{ limit?: number; actual?: number; forecast?: number; byService?: Array<{ service: string; amount: number }>; byServiceError?: string }>;
}

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, error: `${e.name ?? 'Error'}: ${e.message ?? String(err)}`.slice(0, 160) };
  }
}

/** Results that change slowly (daily storage metrics, Logs Insights, cost) are reused between --watch refreshes. */
export class SlowCache {
  private readonly entries = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly ttlMs: number) {}
  async get<T>(key: string, load: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.entries.set(key, { at: Date.now(), value });
    return value;
  }
}

export async function collectUsage(
  ctx: StageContext,
  identity: AwsIdentity,
  opts: { range: RangeKey; cost: boolean; cache: SlowCache },
): Promise<UsageData> {
  const region = ctx.region;
  const n = names(ctx.config, ctx.stageName);
  const rangeS = RANGES[opts.range];
  const seriesUnit = opts.range === '24h' ? 'hour' : 'day';
  const bucketS = seriesUnit === 'hour' ? 3600 : 86_400;
  const buckets = Math.round(rangeS / bucketS);
  // Align the window to whole UTC hours or days: CloudWatch returns datapoints on a grid that
  // starts at StartTime, and the last bucket is the current (partial) hour or day.
  const end = new Date();
  const start = new Date((Math.floor(end.getTime() / 1000 / bucketS) - (buckets - 1)) * bucketS * 1000);
  const cw = new CloudWatchClient({ region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const resources = await stackResources(region, [n.stackName, sharedStackName(ctx.config)]).catch(() => []);
  const functions = resources.filter((r) => r.type === 'AWS::Lambda::Function');
  const apiId = new URL(ctx.outputs.ApiUrl).hostname.split('.')[0]!;

  // One GetMetricData call for everything measured over the range.
  const queries: MetricDataQuery[] = [
    mq('received', 'AWS/SES', 'Received', { RuleName: n.ruleName }, 'Sum', bucketS),
    mq('publishfail', 'AWS/SES', 'PublishFailure', { RuleName: n.ruleName }, 'Sum', rangeS),
    mq('conc', 'AWS/Lambda', 'ConcurrentExecutions', {}, 'Maximum', rangeS),
    mq('apicount', 'AWS/ApiGateway', 'Count', { ApiId: apiId }, 'Sum', rangeS),
    mq('api4xx', 'AWS/ApiGateway', '4xx', { ApiId: apiId }, 'Sum', rangeS),
    mq('api5xx', 'AWS/ApiGateway', '5xx', { ApiId: apiId }, 'Sum', rangeS),
    mq('apip95', 'AWS/ApiGateway', 'Latency', { ApiId: apiId }, 'p95', rangeS),
    ...functions.flatMap((f, i) => [
      mq(`f${i}inv`, 'AWS/Lambda', 'Invocations', { FunctionName: f.physicalId }, 'Sum', rangeS),
      mq(`f${i}err`, 'AWS/Lambda', 'Errors', { FunctionName: f.physicalId }, 'Sum', rangeS),
      mq(`f${i}thr`, 'AWS/Lambda', 'Throttles', { FunctionName: f.physicalId }, 'Sum', rangeS),
      mq(`f${i}p95`, 'AWS/Lambda', 'Duration', { FunctionName: f.physicalId }, 'p95', rangeS),
    ]),
  ];
  const metrics = await section(() => metricData(cw, queries, start, end));
  const m = (id: string) => (metrics.ok ? (metrics.data[id] ?? []) : []);
  const sum = (id: string) => m(id).reduce((a, b) => a + b, 0);
  const last = (id: string) => m(id).at(-1);
  const requireMetrics = () => {
    if (!metrics.ok) throw new Error(metrics.error);
  };

  const [header, receiving, inboxes, accounts, parsers, lambdas, queue, storage, api, alarms, cost] = await Promise.all([
    section(async () => ({
      account: identity.account,
      arn: identity.arn,
      profile: identity.profile,
      ssoExpiresAt: ssoSessionExpiry()?.toISOString(),
    })),
    section(async () => {
      requireMetrics();
      const ses = new SESClient({ region });
      const [ruleEnabled, breaker, account, filters] = await Promise.all([
        isReceiving(ses, ctx.outputs.RuleSetName, ctx.outputs.RuleName),
        ddb.send(new GetCommand({ TableName: ctx.outputs.TableName, Key: { pk: ddbKeys.breaker, sk: META } })).then((r) => r.Item),
        new SESv2Client({ region }).send(new GetAccountCommand({})),
        ses.send(new ListReceiptFiltersCommand({})),
      ]);
      return {
        rule: n.ruleName,
        ruleEnabled,
        breaker: breaker
          ? { paused: Boolean(breaker.paused), at: (breaker.pausedAt ?? breaker.resumedAt) as string | undefined, by: breaker.by as string | undefined, alarm: breaker.alarm as string | undefined }
          : null,
        autoPause: ctx.stage.autoPause,
        sesProduction: Boolean(account.ProductionAccessEnabled),
        blockedIps: (filters.Filters ?? [])
          .filter((f) => f.Name?.startsWith(`${ctx.config.project}-block-`) && f.IpFilter?.Policy === 'Block')
          .map((f) => f.IpFilter?.Cidr ?? '?'),
        received: sum('received'),
        series: timeSeries(metrics.ok ? metrics.data.__timestamps?.received : undefined, m('received'), start, bucketS, buckets),
        seriesUnit,
        publishFailures: sum('publishfail'),
      } as const;
    }),
    section(async () => {
      // Held mail is at most a day or two old; count today's and yesterday's feed partitions.
      const nowS = Math.floor(Date.now() / 1000);
      const days = [0, 1, 2].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10));
      const recipients = new Set<string>();
      let messages = 0;
      for (const domain of ctx.stage.domains) {
        for (const day of days) {
          let startKey: Record<string, unknown> | undefined;
          do {
            const page = await ddb.send(
              new QueryCommand({
                TableName: ctx.outputs.TableName,
                KeyConditionExpression: 'pk = :pk',
                FilterExpression: 'attribute_not_exists(#ttl) OR #ttl > :now',
                ProjectionExpression: 'recipients',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':pk': ddbKeys.feed(domain, day), ':now': nowS },
                ExclusiveStartKey: startKey,
              }),
            );
            for (const item of page.Items ?? []) {
              messages++;
              for (const r of (item.recipients as string[] | undefined) ?? []) recipients.add(r);
            }
            startKey = page.LastEvaluatedKey;
          } while (startKey);
        }
      }
      return { messages, addresses: recipients.size, retentionHours: ctx.stage.retentionHours };
    }),
    section(async () => {
      const byService = new Map<string, number>();
      let total = 0;
      let withPassword = 0;
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await ddb.send(
          new ScanCommand({
            TableName: ctx.outputs.AccountsTableName,
            ProjectionExpression: 'service, password',
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of page.Items ?? []) {
          total++;
          if (item.password) withPassword++;
          byService.set(item.service as string, (byService.get(item.service as string) ?? 0) + 1);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return {
        total,
        withPassword,
        byService: [...byService].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count),
      };
    }),
    section(async () => {
      const rules = ctx.stage.parsers.map((p) => ({ name: p.name, module: p.module, match: describeMatch(p.match), timeoutS: p.timeoutSeconds }));
      const logGroup = resources.find((r) => r.type === 'AWS::Logs::LogGroup' && r.logicalId.startsWith('IngestFnLogs'))?.physicalId;
      if (!logGroup) return { rules, runs: {}, runsNote: 'ingest log group not found' };
      // Logs are kept 14 days, which is also the longest range offered.
      const runs = await opts.cache.get(`runs:${ctx.stageName}:${opts.range}`, () => parserRuns(region, logGroup, start, end));
      return { rules, runs };
    }),
    section(async () => {
      requireMetrics();
      const lambda = new LambdaClient({ region });
      const settings = await lambda.send(new GetAccountSettingsCommand({}));
      const configs = await Promise.all(functions.map((f) => lambda.send(new GetFunctionConfigurationCommand({ FunctionName: f.physicalId }))));
      return {
        concurrencyLimit: settings.AccountLimit?.ConcurrentExecutions,
        peakConcurrency: m('conc').length ? Math.max(...m('conc')) : 0,
        functions: functions
          .map((f, i) => {
          const c = configs[i]!;
          return {
            name: friendlyName(f.logicalId),
            stack: f.stack === n.stackName ? ctx.stageName : 'shared',
            runtime: c.Runtime,
            arch: c.Architectures?.[0],
            memoryMb: c.MemorySize,
            timeoutS: c.Timeout,
            codeBytes: c.CodeSize,
            invocations: sum(`f${i}inv`),
            errors: sum(`f${i}err`),
            throttles: sum(`f${i}thr`),
            p95Ms: last(`f${i}p95`),
            helper: f.logicalId.startsWith('CustomS3AutoDeleteObjects') || f.stack !== n.stackName,
          };
        })
          .sort((a, b) => Number(a.helper) - Number(b.helper) || FUNCTION_ORDER.indexOf(a.name) - FUNCTION_ORDER.indexOf(b.name)),
      };
    }),
    section(async () => {
      const sqs = new SQSClient({ region });
      const attrs = async (url: string) =>
        (
          await sqs.send(
            new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
          )
        ).Attributes ?? {};
      const [q, dlq] = await Promise.all([attrs(ctx.outputs.IngestQueueUrl), attrs(ctx.outputs.IngestDlqUrl)]);
      return {
        waiting: Number(q.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(q.ApproximateNumberOfMessagesNotVisible ?? 0),
        dlq: Number(dlq.ApproximateNumberOfMessages ?? 0),
      };
    }),
    section(() =>
      opts.cache.get(`storage:${ctx.stageName}`, async () => {
        const raw = new DynamoDBClient({ region });
        // S3 storage metrics are published once a day, so look back three days for the latest.
        const s3 = await metricData(
          cw,
          [
            mq('bytes', 'AWS/S3', 'BucketSizeBytes', { BucketName: ctx.outputs.BucketName, StorageType: 'StandardStorage' }, 'Average', 86_400),
            mq('objects', 'AWS/S3', 'NumberOfObjects', { BucketName: ctx.outputs.BucketName, StorageType: 'AllStorageTypes' }, 'Average', 86_400),
          ],
          new Date(Date.now() - 3 * 86_400_000),
          new Date(),
        );
        const [index, accounts, backups] = await Promise.all([
          raw.send(new DescribeTableCommand({ TableName: ctx.outputs.TableName })),
          raw.send(new DescribeTableCommand({ TableName: ctx.outputs.AccountsTableName })),
          raw.send(new DescribeContinuousBackupsCommand({ TableName: ctx.outputs.AccountsTableName })),
        ]);
        const stamps = s3.__timestamps?.bytes;
        return {
          s3: { bytes: s3.bytes?.at(-1), objects: s3.objects?.at(-1), asOf: stamps?.at(-1)?.slice(0, 10) },
          index: { items: index.Table?.ItemCount, bytes: index.Table?.TableSizeBytes },
          accounts: {
            items: accounts.Table?.ItemCount,
            bytes: accounts.Table?.TableSizeBytes,
            backups: backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus,
          },
        };
      }),
    ),
    section(async () => {
      requireMetrics();
      return { requests: sum('apicount'), errors4xx: sum('api4xx'), errors5xx: sum('api5xx'), p95Ms: last('apip95') };
    }),
    section(async () => {
      const out = await cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: `${ctx.config.project}-${ctx.stageName}-` }));
      return (out.MetricAlarms ?? []).map((a) => ({ name: a.AlarmName!, state: a.StateValue! }));
    }),
    section(() =>
      opts.cache.get(
        `cost:${opts.cost}`,
        async () => {
          const result: {
            limit?: number;
            actual?: number;
            forecast?: number;
            byService?: Array<{ service: string; amount: number }>;
            byServiceError?: string;
          } = {};
          if (ctx.config.monthlyBudgetUsd !== undefined) {
            // Budgets is free to query; region-less, served from us-east-1.
            const { Budget } = await new BudgetsClient({ region: 'us-east-1' }).send(
              new DescribeBudgetCommand({ AccountId: identity.account, BudgetName: `${ctx.config.project}-monthly` }),
            );
            result.limit = num(Budget?.BudgetLimit?.Amount);
            result.actual = num(Budget?.CalculatedSpend?.ActualSpend?.Amount);
            result.forecast = num(Budget?.CalculatedSpend?.ForecastedSpend?.Amount);
          }
          if (opts.cost) {
            // Cost Explorer can be off or empty on new accounts; that must not hide the budget.
            try {
              result.byService = await costByService();
            } catch (err) {
              result.byServiceError = (err as { name?: string }).name === 'DataUnavailableException'
                ? 'Cost Explorer has no data yet (new accounts take up to a day after it is enabled)'
                : (err as Error).message;
            }
          }
          return result;
        },
        // Cost Explorer charges $0.01 per request: fetch it once per run.
        Number.POSITIVE_INFINITY,
      ),
    ),
  ]);

  return {
    generatedAt: end.toISOString(),
    stage: ctx.stageName,
    region,
    range: opts.range,
    header,
    receiving,
    inboxes,
    accounts,
    parsers,
    lambdas,
    queue,
    storage,
    api,
    alarms,
    cost,
  };
}

// ---- helpers ----------------------------------------------------------------------------

const FUNCTION_ORDER = ['Ingest', 'Api', 'Breaker'];

function mq(id: string, namespace: string, metric: string, dims: Record<string, string>, stat: string, period: number): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: { Namespace: namespace, MetricName: metric, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })) },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  };
}

type MetricValues = Record<string, number[]> & { __timestamps?: Record<string, string[]> };

async function metricData(cw: CloudWatchClient, queries: MetricDataQuery[], start: Date, end: Date): Promise<MetricValues> {
  const values: Record<string, number[]> = {};
  const timestamps: Record<string, string[]> = {};
  for (let i = 0; i < queries.length; i += 500) {
    let next: string | undefined;
    do {
      const out = await cw.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries.slice(i, i + 500),
          StartTime: start,
          EndTime: end,
          ScanBy: 'TimestampAscending',
          NextToken: next,
        }),
      );
      for (const r of out.MetricDataResults ?? []) {
        values[r.Id!] = [...(values[r.Id!] ?? []), ...(r.Values ?? [])];
        timestamps[r.Id!] = [...(timestamps[r.Id!] ?? []), ...(r.Timestamps ?? []).map((t) => t.toISOString())];
      }
      next = out.NextToken;
    } while (next);
  }
  return Object.assign(values, { __timestamps: timestamps }) as MetricValues;
}

/** Places sparse datapoints into fixed buckets so the sparkline shows quiet periods as zero. */
function timeSeries(stamps: string[] | undefined, values: number[], start: Date, bucketS: number, buckets: number): number[] {
  const out = new Array<number>(buckets).fill(0);
  (stamps ?? []).forEach((t, i) => {
    // Round, not floor: CloudWatch truncates timestamps to the minute.
    const b = Math.round((Date.parse(t) - start.getTime()) / (bucketS * 1000));
    if (b >= 0 && b < buckets) out[b] = (out[b] ?? 0) + (values[i] ?? 0);
  });
  return out;
}

async function stackResources(region: string, stacks: string[]) {
  const cfn = new CloudFormationClient({ region });
  const out: Array<{ stack: string; logicalId: string; physicalId: string; type: string }> = [];
  for (const stack of stacks) {
    try {
      for await (const page of paginateListStackResources({ client: cfn }, { StackName: stack })) {
        for (const r of page.StackResourceSummaries ?? []) {
          if (r.PhysicalResourceId) out.push({ stack, logicalId: r.LogicalResourceId!, physicalId: r.PhysicalResourceId, type: r.ResourceType! });
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== 'ValidationError') throw err;
    }
  }
  return out;
}

/** "IngestFnEE15D018" -> "Ingest"; "ActivatorProviderframeworkonEventA..." -> "ActivatorProvider" */
function friendlyName(logicalId: string): string {
  if (logicalId.startsWith('CustomS3AutoDeleteObjects')) return 'S3AutoDelete';
  if (logicalId.startsWith('ActivatorProvider')) return 'ActivatorFramework';
  if (logicalId.startsWith('ActivatorFn')) return 'Activator';
  const m = /^([A-Za-z]+?)Fn[0-9A-F]{8}$/.exec(logicalId);
  return m?.[1] ?? logicalId.replace(/[0-9A-F]{8}$/, '');
}

function describeMatch(match: { recipient?: string | string[]; from?: string | string[]; subject?: string }): string {
  const parts: string[] = [];
  const list = (v: string | string[]) => (Array.isArray(v) ? v.join('|') : v);
  if (match.recipient) parts.push(`to ${list(match.recipient)}`);
  if (match.from) parts.push(`from ${list(match.from)}`);
  if (match.subject) parts.push(`subject /${match.subject}/`);
  return parts.length ? parts.join(', ') : 'all mail';
}

async function parserRuns(region: string, logGroup: string, start: Date, end: Date): Promise<Record<string, { ok: number; error: number }>> {
  const logs = new CloudWatchLogsClient({ region });
  const { queryId } = await logs.send(
    new StartQueryCommand({
      logGroupName: logGroup,
      startTime: Math.floor(start.getTime() / 1000),
      endTime: Math.floor(end.getTime() / 1000),
      queryString: [
        'fields @message',
        '| filter @message like /"msg":"parser run"/',
        '| parse @message /"parser":"(?<parser>[^"]+)","status":"(?<status>[^"]+)"/',
        '| stats count(*) as runs by parser, status',
      ].join('\n'),
    }),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const out = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (out.status === 'Complete') {
      const runs: Record<string, { ok: number; error: number }> = {};
      for (const row of out.results ?? []) {
        const get = (f: string) => row.find((c) => c.field === f)?.value;
        const parser = get('parser');
        const status = get('status');
        if (!parser || (status !== 'ok' && status !== 'error')) continue;
        runs[parser] ??= { ok: 0, error: 0 };
        runs[parser][status] += Number(get('runs') ?? 0);
      }
      return runs;
    }
    if (out.status === 'Failed' || out.status === 'Cancelled' || out.status === 'Timeout' || Date.now() > deadline) {
      throw new Error(`Logs Insights query ${out.status ?? 'timed out'}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function costByService(): Promise<Array<{ service: string; amount: number }>> {
  const now = new Date();
  const startOfMonth = `${now.toISOString().slice(0, 8)}01`;
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const out = await new CostExplorerClient({ region: 'us-east-1' }).send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: startOfMonth, End: tomorrow },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );
  const totals = new Map<string, number>();
  for (const period of out.ResultsByTime ?? []) {
    for (const g of period.Groups ?? []) {
      const service = g.Keys?.[0] ?? 'other';
      totals.set(service, (totals.get(service) ?? 0) + Number(g.Metrics?.UnblendedCost?.Amount ?? 0));
    }
  }
  return [...totals]
    .map(([service, amount]) => ({ service, amount }))
    .filter((s) => s.amount >= 0.005)
    .sort((a, b) => b.amount - a.amount);
}

function num(v: string | undefined): number | undefined {
  return v === undefined ? undefined : Number(v);
}
