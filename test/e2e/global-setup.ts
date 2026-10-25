import { randomBytes } from 'node:crypto';
import { GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { TestProject } from 'vitest/node';
import { InboxApi } from '../../cli/api-client';
import { loadConfig } from '../../config/load';
import { createToken, resume, revokeToken } from '../../cli/admin';
import { ensureAwsSession, useProfile } from '../../cli/aws-session';
import { stageContext, type StageOutputs } from '../../cli/stack';

export interface E2EContext {
  stage: string;
  region: string;
  domain: string;
  /** Domain the tests send from; see pickSenderDomain. */
  senderDomain: string;
  apiUrl: string;
  token: string;
  tokenName: string;
  outputs: StageOutputs;
}

declare module 'vitest' {
  export interface ProvidedContext {
    e2e: E2EContext;
  }
}

/**
 * Runs once before the E2E suite against a deployed stage (E2E_STAGE, default "e2e"):
 * waits until the stage's SES identity has working DKIM, makes sure receiving is on,
 * mints a throwaway API token that is revoked afterwards, picks the domain to send test
 * mail from, and proves mail from it arrives signed.
 */
export default async function setup(project: TestProject) {
  const stage = process.env.E2E_STAGE ?? 'e2e';
  const config = await loadConfig();
  await ensureAwsSession(config.region, useProfile(undefined, config.awsProfile));
  const ctx = await stageContext(stage);
  const domain = ctx.outputs.Domains.split(',')[0]!;

  const ses = new SESv2Client({ region: ctx.region });
  const deadline = Date.now() + 15 * 60_000;
  // The stage creates this identity and its DKIM records on every deploy; this proves they work.
  for (;;) {
    const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    if (identity.VerifiedForSendingStatus && identity.DkimAttributes?.Status === 'SUCCESS') break;
    if (Date.now() > deadline) throw new Error(`SES identity ${domain} still has no working DKIM; check its DKIM records`);
    console.log(`waiting for SES to verify ${domain} (DKIM: ${identity.DkimAttributes?.Status ?? 'unknown'})`);
    await new Promise((r) => setTimeout(r, 15_000));
  }

  await resume(ctx);
  const tokenName = `e2e-${Date.now()}`;
  const token = await createToken(ctx, tokenName);
  const senderDomain = await pickSenderDomain(ses, domain);
  console.log(`sending test mail from ${senderDomain}`);
  await probeSignedDelivery(ses, new InboxApi({ apiUrl: ctx.outputs.ApiUrl, token }), senderDomain, domain, deadline);
  project.provide('e2e', { stage, region: ctx.region, domain, senderDomain, apiUrl: ctx.outputs.ApiUrl, token, tokenName, outputs: ctx.outputs });

  return async () => {
    await revokeToken(ctx, tokenName).catch(() => undefined);
  };
}

/**
 * The e2e stage is created fresh for every run, and for several minutes after its DKIM keys
 * verify, SES still sends some of its mail unsigned (seen as dkim=GRAY, dmarc=FAIL at random).
 * So tests send from the nearest parent domain with its own long-lived, DKIM-verified identity
 * (prod's, when e2e is a subdomain of it), and fall back to the stage's own domain.
 */
async function pickSenderDomain(ses: SESv2Client, domain: string): Promise<string> {
  const labels = domain.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join('.');
    const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: parent })).catch(() => undefined);
    if (identity?.VerifiedForSendingStatus && identity.DkimAttributes?.Status === 'SUCCESS' && identity.DkimAttributes.SigningEnabled) return parent;
  }
  return domain;
}

/** Sends probe mail until one arrives DKIM-signed and DMARC-aligned, the way the tests expect their own mail to. */
async function probeSignedDelivery(ses: SESv2Client, api: InboxApi, senderDomain: string, domain: string, deadline: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const to = `probe-${randomBytes(4).toString('hex')}@${domain}`;
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: `sender@${senderDomain}`,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: 'e2e probe' }, Body: { Text: { Data: 'probe' } } } },
      }),
    );
    for (const until = Date.now() + 60_000; Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 3_000));
      const [entry] = (await api.listInbox(to, { limit: 1 })).messages;
      if (!entry) continue;
      const { verdicts } = await api.message(entry.id);
      if (verdicts.dkim === 'PASS' && verdicts.dmarc === 'PASS') return;
      console.log(`probe ${attempt} arrived with dkim=${verdicts.dkim} dmarc=${verdicts.dmarc}; retrying`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`mail from ${senderDomain} still does not arrive DKIM-signed`);
  }
}
