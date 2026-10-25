import { z } from 'zod';
import { PARSER_MODULE_NAMES } from '../parsers/names';

/**
 * Regions where SES classic email receiving is available (checked against the
 * SES endpoints page, Sep 2026). The Lambda, SNS topic, and receipt rules must
 * all live in the receiving region.
 */
export const RECEIVING_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ca-central-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-south-1',
  'eu-north-1',
  'il-central-1',
  'me-south-1',
  'sa-east-1',
] as const;

const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a lowercase hostname');

const globs = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const parserSchema = z
  .object({
    /** Unique name; used as the S3 output key and the status field. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes, max 40 chars'),
    /** Parser module to run, a key of PARSER_MODULES in parsers/registry.ts. */
    module: z.enum(PARSER_MODULE_NAMES),
    match: z
      .object({
        /** Recipient glob(s). Without "@" the glob matches the local part only. */
        recipient: globs.optional(),
        /** Sender glob(s) against the From header. Without "@" the glob matches the domain only. */
        from: globs.optional(),
        /** Case-insensitive regular expression tested against the subject. */
        subject: z.string().optional(),
      })
      .default({}),
    /** From-header matches only count when DMARC passes, because From is trivially spoofed. */
    requireDmarcForFrom: z.boolean().default(true),
    /** Skip mail that SES flagged as spam. */
    skipSpam: z.boolean().default(false),
    /** The parser runs in a worker thread that is terminated after this long. */
    timeoutSeconds: z.number().int().min(1).max(30).default(5),
  })
  .refine((p) => p.match.subject === undefined || isValidRegex(p.match.subject), {
    message: '`match.subject` must be a valid regular expression',
  });

export const stageSchema = z.object({
  /** Receiving domains. Each is matched exactly by the receipt rule (subdomains are not included). */
  domains: z.array(hostname).min(1),
  /** Route 53 public hosted zone that contains the domains. Omit to manage DNS by hand. */
  hostedZone: z
    .object({
      zoneName: hostname,
      /** Optional; preflight looks it up by name when omitted. */
      hostedZoneId: z.string().optional(),
    })
    .optional(),
  /** Create the SES identity (and its DKIM records when a hosted zone is set). */
  manageIdentity: z.boolean().default(true),
  /**
   * Publish a DMARC record for each domain. `reject` is right for receive-only domains:
   * nobody can spoof mail from them. Requires `hostedZone`.
   */
  dmarc: z.enum(['off', 'none', 'quarantine', 'reject']).default('off'),
  parsers: z.array(parserSchema).default([]),
  /** Only index these recipients (globs, same syntax as parser recipient globs). Default: everything. */
  addressAllowlist: z.array(z.string().min(1)).optional(),
  /**
   * Received mail is hidden by the API after this many hours and deleted by DynamoDB TTL and an
   * S3 lifecycle rule (which works in whole days, so objects go within a day after that).
   */
  retentionHours: z.number().int().min(1).max(24 * 3650).default(24),
  /** Disable the receipt rule automatically when accepted mail exceeds these counts. */
  autoPause: z
    .object({
      perHour: z.number().int().positive(),
      perDay: z.number().int().positive(),
    })
    .default({ perHour: 500, perDay: 5000 }),
  ingest: z
    .object({
      /** Concurrent ingest Lambdas. Keep the sum across stages below the account's Lambda concurrency. */
      maxConcurrency: z.number().int().min(2).max(1000).default(4),
    })
    .default({ maxConcurrency: 4 }),
  api: z
    .object({
      rateLimit: z.number().positive().default(20),
      burstLimit: z.number().int().positive().default(40),
      tokenCacheSeconds: z.number().int().min(0).max(3600).default(60),
    })
    .default({ rateLimit: 20, burstLimit: 40, tokenCacheSeconds: 60 }),
  /** `retain` keeps the bucket and table when the stack is deleted. Use `destroy` only for test stages. */
  removalPolicy: z.enum(['retain', 'destroy']).default('retain'),
});

export const configSchema = z
  .object({
    /** Prefix for stack names and physical resource names. */
    project: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/).default('ses-inbox'),
    region: z.enum(RECEIVING_REGIONS),
    /** AWS CLI profile for deploys and admin commands, unless --profile or AWS_PROFILE is set. */
    awsProfile: z.string().min(1).optional(),
    /** Receives alarm and auto-pause emails. Required because auto-pause is always on. */
    alertEmail: z.email(),
    /** Monthly AWS Budgets alert for the whole account. */
    monthlyBudgetUsd: z.number().positive().optional(),
    /** Name of the rule set this project creates when no rule set is active in the region. */
    ruleSetName: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).default('ses-inbox-rules'),
    stages: z.record(z.string().regex(/^[a-z][a-z0-9]{0,15}$/), stageSchema),
  })
  .superRefine((config, ctx) => {
    const owner = new Map<string, string>();
    for (const [stage, s] of Object.entries(config.stages)) {
      for (const domain of s.domains) {
        const prev = owner.get(domain);
        if (prev) ctx.addIssue({ code: 'custom', message: `domain ${domain} is used by stages ${prev} and ${stage}` });
        owner.set(domain, stage);
        if (s.hostedZone && !isWithinZone(domain, s.hostedZone.zoneName)) {
          ctx.addIssue({ code: 'custom', message: `domain ${domain} is not inside hosted zone ${s.hostedZone.zoneName}` });
        }
      }
      if (s.dmarc !== 'off' && !s.hostedZone) {
        ctx.addIssue({ code: 'custom', message: `stage ${stage}: dmarc requires hostedZone` });
      }
      const names = new Set<string>();
      for (const p of s.parsers) {
        if (names.has(p.name)) ctx.addIssue({ code: 'custom', message: `stage ${stage}: duplicate parser ${p.name}` });
        names.add(p.name);
      }
    }
  });

export type InboxConfigInput = z.input<typeof configSchema>;
export type InboxConfig = z.output<typeof configSchema>;
export type StageConfig = z.output<typeof stageSchema>;
export type ParserConfig = z.output<typeof parserSchema>;

/** Identity helper so `inbox.config.ts` gets type checking and editor completion. */
export function defineConfig(config: InboxConfigInput): InboxConfigInput {
  return config;
}

export function parseConfig(raw: unknown): InboxConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid inbox.config.ts:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function isWithinZone(domain: string, zone: string): boolean {
  return domain === zone || domain.endsWith(`.${zone}`);
}

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

/** Physical names shared by the stack, the CLI, and the tests. */
export function names(config: Pick<InboxConfig, 'project'>, stage: string) {
  const prefix = `${config.project}-${stage}`;
  return {
    stackName: `${capitalize(config.project)}-${stage}`,
    ruleName: prefix,
    alarmPrefix: prefix,
    hourlyAlarm: `${prefix}-autopause-hourly`,
    dailyAlarm: `${prefix}-autopause-daily`,
  };
}

export function sharedStackName(config: Pick<InboxConfig, 'project'>): string {
  return `${capitalize(config.project)}-shared`;
}

function capitalize(s: string): string {
  return s
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
