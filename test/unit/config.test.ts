import { describe, expect, it } from 'vitest';
import config from '../../inbox.example';
import { parseConfig } from '../../config/schema';

const valid = {
  region: 'us-east-1',
  alertEmail: 'ops@example.com',
  stages: { prod: { domains: ['in.example.com'], hostedZone: { zoneName: 'example.com' } } },
};

describe('config schema', () => {
  it('accepts the generic inbox.example.ts', () => {
    expect(() => parseConfig(config)).not.toThrow();
  });

  it('fills in defaults', () => {
    const c = parseConfig(valid);
    expect(c.ruleSetName).toBe('ses-inbox-rules');
    expect(c.stages.prod).toMatchObject({
      manageIdentity: true,
      dmarc: 'off',
      removalPolicy: 'retain',
      retentionHours: 24,
      ingest: { maxConcurrency: 4 },
      autoPause: { perHour: 500, perDay: 5000 },
    });
  });

  it('rejects regions without SES receiving', () => {
    expect(() => parseConfig({ ...valid, region: 'ap-south-2' })).toThrow(/region/);
  });

  it('rejects a domain claimed by two stages or outside its zone', () => {
    expect(() =>
      parseConfig({ ...valid, stages: { a: { domains: ['in.example.com'] }, b: { domains: ['in.example.com'] } } }),
    ).toThrow(/used by stages a and b/);
    expect(() => parseConfig({ ...valid, stages: { a: { domains: ['in.other.com'], hostedZone: { zoneName: 'example.com' } } } })).toThrow(
      /not inside hosted zone/,
    );
  });

  it('validates parsers', () => {
    const stage = (parsers: unknown[]) => ({ ...valid, stages: { prod: { domains: ['in.example.com'], parsers } } });
    expect(() => parseConfig(stage([{ name: 'x' }]))).toThrow(/module/);
    expect(() => parseConfig(stage([{ name: 'x', module: 'nope' }]))).toThrow(/module/);
    expect(() => parseConfig(stage([{ name: 'x', module: 'otp', match: { subject: '(' } }]))).toThrow(/regular expression/);
    expect(() => parseConfig(stage([{ name: 'x', module: 'otp' }, { name: 'x', module: 'jagex' }]))).toThrow(/duplicate parser/);
    expect(() => parseConfig(stage([{ name: 'x', module: 'otp', timeoutSeconds: 60 }]))).toThrow();
  });
});
