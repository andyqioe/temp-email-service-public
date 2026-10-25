import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { UsageData } from '../../cli/insights';
import { stripAnsi } from '../../cli/ui/text';
import { renderUsage } from '../../cli/usage';

beforeAll(() => {
  process.env.NO_COLOR = '1';
});

const data: UsageData = {
  generatedAt: '2026-09-22T20:15:00.000Z',
  stage: 'prod',
  region: 'us-east-2',
  range: '7d',
  header: { ok: true, data: { account: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/Admin/me', profile: 'qmail-admin', ssoExpiresAt: '2026-09-23T04:27:00.000Z' } },
  receiving: {
    ok: true,
    data: {
      rule: 'ses-inbox-prod',
      ruleEnabled: true,
      breaker: null,
      autoPause: { perHour: 500, perDay: 5000 },
      sesProduction: false,
      blockedIps: ['203.0.113.0/24', '198.51.100.7'],
      received: 42,
      series: [0, 3, 8, 12, 0, 9, 10],
      seriesUnit: 'day',
      publishFailures: 0,
    },
  },
  inboxes: { ok: true, data: { messages: 12, addresses: 5, retentionHours: 24 } },
  accounts: { ok: true, data: { total: 3, withPassword: 2, byService: [{ service: 'jagex', count: 2 }, { service: 'github', count: 1 }] } },
  parsers: {
    ok: true,
    data: {
      rules: [
        { name: 'otp', module: 'otp', match: 'all mail', timeoutS: 5 },
        { name: 'jagex', module: 'jagex', match: 'from *@contact.jagex.com, subject /verification code/', timeoutS: 5 },
      ],
      runs: { otp: { ok: 40, error: 0 }, jagex: { ok: 2, error: 1 } },
    },
  },
  lambdas: {
    ok: true,
    data: {
      concurrencyLimit: 1000,
      peakConcurrency: 3,
      functions: [
        { name: 'Ingest', stack: 'prod', runtime: 'nodejs24.x', arch: 'arm64', memoryMb: 1024, timeoutS: 120, codeBytes: 2_400_000, invocations: 42, errors: 0, throttles: 0, p95Ms: 850 },
        { name: 'Api', stack: 'prod', runtime: 'nodejs24.x', arch: 'arm64', memoryMb: 512, timeoutS: 29, codeBytes: 1_900_000, invocations: 310, errors: 0, throttles: 0, p95Ms: 60 },
        { name: 'Activator', stack: 'shared', helper: true, runtime: 'nodejs24.x', arch: 'arm64', memoryMb: 256, timeoutS: 60, codeBytes: 460_000, invocations: 0, errors: 0, throttles: 0 },
      ],
    },
  },
  queue: { ok: true, data: { waiting: 0, inFlight: 0, dlq: 0 } },
  storage: {
    ok: true,
    data: { s3: {}, index: { items: 120, bytes: 92_000 }, accounts: { items: 3, bytes: 900, backups: 'ENABLED' } },
  },
  api: { ok: true, data: { requests: 310, errors4xx: 3, errors5xx: 0, p95Ms: 120 } },
  alarms: { ok: false, error: 'AccessDenied: not authorized' },
  cost: { ok: true, data: { limit: 10, actual: 0.42, forecast: 1.1 } },
};

describe('qmail usage rendering', () => {
  const lines = renderUsage(data, 100).map(stripAnsi);

  it('fits a 100-column terminal', () => {
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  it('shows every section, and a failing one without hiding the rest', () => {
    const text = lines.join('\n');
    for (const title of ['Receiving', 'Inboxes (mail kept 24h)', 'Accounts', 'Parsers', 'Lambda', 'Queue', 'Storage', 'HTTP API', 'Alarms', 'Cost']) {
      expect(text).toContain(title);
    }
    expect(text).toContain('unavailable: AccessDenied: not authorized');
    expect(text).toContain('42 in 7d');
    expect(text).toContain('▁');
    expect(text).toContain('pending (S3 publishes storage metrics once a day)');
    expect(text).toContain('$0.42 of $10.00 budget');
  });

  it('matches the reviewed layout', () => {
    expect(lines.join('\n')).toMatchSnapshot();
  });

  it('measures times from when the data was collected, not from the wall clock', () => {
    expect(lines.join('\n')).toContain('SSO expires in 8h 12m');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      expect(renderUsage(data, 100).map(stripAnsi)).toEqual(lines);
    } finally {
      vi.useRealTimers();
    }
  });
});
