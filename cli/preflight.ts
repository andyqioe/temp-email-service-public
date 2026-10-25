import { resolveMx } from 'node:dns/promises';
import { CloudFormationClient, DescribeStacksCommand, paginateListStackResources } from '@aws-sdk/client-cloudformation';
import { ListHostedZonesByNameCommand, ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { DescribeActiveReceiptRuleSetCommand, DescribeReceiptRuleSetCommand, SESClient } from '@aws-sdk/client-ses';
import { GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { loadConfig, stageOf } from '../config/load';
import { names } from '../config/schema';
import { readPreflight, writePreflight, PREFLIGHT_FILE, type PreflightState } from '../infra/lib/preflight-state';
import { isReceiving } from '../services/shared/receiving';

export interface PreflightReport {
  state: PreflightState;
  notes: string[];
  /** False when CDK has never been bootstrapped in this account and region (`npm run deploy` does it). */
  bootstrapped: boolean;
}

/**
 * Inspects the live account before a deploy and records what CloudFormation cannot know:
 * which receipt rule set is active, whether our rule is paused, and the hosted zone id.
 * Fails loudly on conflicts (an identity or DNS record that exists but is not ours)
 * instead of silently skipping them.
 */
export async function preflight(stageName: string): Promise<PreflightReport> {
  const config = await loadConfig();
  const stage = stageOf(config, stageName);
  const region = config.region;
  const notes: string[] = [];
  const problems: string[] = [];

  const { Account: account } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  if (!account) throw new Error('could not determine the AWS account (check your credentials)');
  notes.push(`account ${account}, region ${region}`);

  const cfn = new CloudFormationClient({ region });
  const bootstrapped = await stackExists(cfn, 'CDKToolkit');
  if (!bootstrapped) notes.push(`CDK is not bootstrapped in ${region} yet`);

  const ses = new SESClient({ region });
  const active = (await ses.send(new DescribeActiveReceiptRuleSetCommand({}))).Metadata?.Name;
  const ours = await ruleSetExists(ses, config.ruleSetName);
  let ruleSet: PreflightState['ruleSet'];
  if (!active || active === config.ruleSetName) {
    ruleSet = { name: config.ruleSetName, owned: true };
    notes.push(active ? `receipt rule set ${active} is active (ours)` : `no receipt rule set is active; ${config.ruleSetName} will be created and activated`);
  } else if (ours) {
    problems.push(
      `receipt rule set "${active}" is active, but this project's "${config.ruleSetName}" also exists. ` +
        `Only one can be active; activate one deliberately in the SES console, then rerun.`,
    );
    ruleSet = { name: config.ruleSetName, owned: true };
  } else {
    ruleSet = { name: active, owned: false };
    notes.push(`receipt rule set "${active}" is already active (not ours); stage rules will be added to it`);
  }

  const n = names(config, stageName);
  const enabled = await isReceiving(ses, ruleSet.name, n.ruleName);
  if (enabled === false) notes.push(`receipt rule ${n.ruleName} is PAUSED and will stay paused (run \`qmail resume\` to re-enable)`);

  const owned = await stackResources(cfn, n.stackName);
  const sesv2 = new SESv2Client({ region });
  let hostedZoneId = stage.hostedZone?.hostedZoneId;
  const route53 = new Route53Client({ region });
  if (stage.hostedZone && !hostedZoneId) {
    hostedZoneId = await findPublicZone(route53, stage.hostedZone.zoneName);
    if (!hostedZoneId) problems.push(`no public Route 53 hosted zone named ${stage.hostedZone.zoneName} in this account`);
  }

  for (const domain of stage.domains) {
    if (stage.manageIdentity && (await identityExists(sesv2, domain)) && !owned.has(`AWS::SES::EmailIdentity:${domain}`)) {
      problems.push(
        `SES identity ${domain} already exists but was not created by ${n.stackName}. ` +
          `Set manageIdentity: false for stage ${stageName} (receiving works with any verified identity).`,
      );
    }
    if (hostedZoneId) {
      for (const [name, type] of [
        [domain, 'MX'],
        ...(stage.dmarc !== 'off' ? [[`_dmarc.${domain}`, 'TXT'] as const] : []),
      ] as const) {
        if ((await recordExists(route53, hostedZoneId, name, type)) && !owned.has(`AWS::Route53::RecordSet:${name}`)) {
          problems.push(`${type} record ${name} already exists in the hosted zone and is not managed by ${n.stackName}. Remove it or manage DNS by hand.`);
        }
      }
    } else {
      const mx = await resolveMx(domain).catch(() => []);
      const expected = `inbound-smtp.${region}.amazonaws.com`;
      notes.push(
        mx.some((r) => r.exchange.toLowerCase() === expected)
          ? `${domain}: MX already points at ${expected}`
          : `${domain}: add DNS record "MX 10 ${expected}" (stack outputs list DKIM records too)`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Preflight failed for stage ${stageName}:\n  - ${problems.join('\n  - ')}`);
  }

  const previous = safeRead();
  const state: PreflightState = {
    version: 1,
    generatedAt: new Date().toISOString(),
    account,
    region,
    ruleSet,
    stages: {
      ...(previous?.account === account && previous.region === region ? previous.stages : {}),
      [stageName]: { ruleEnabled: enabled ?? true, ...(hostedZoneId ? { hostedZoneId } : {}) },
    },
  };
  writePreflight(state);
  notes.push(`wrote ${PREFLIGHT_FILE}`);
  return { state, notes, bootstrapped };
}

async function stackExists(cfn: CloudFormationClient, name: string): Promise<boolean> {
  try {
    const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return (Stacks ?? []).some((s) => s.StackStatus !== 'DELETE_COMPLETE');
  } catch (err) {
    if ((err as { name?: string }).name === 'ValidationError') return false;
    throw err;
  }
}

/** "Type:PhysicalId" for every resource in the stack (empty when the stack does not exist yet). */
async function stackResources(cfn: CloudFormationClient, stackName: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!(await stackExists(cfn, stackName))) return out;
  for await (const page of paginateListStackResources({ client: cfn }, { StackName: stackName })) {
    for (const r of page.StackResourceSummaries ?? []) {
      if (r.PhysicalResourceId) out.add(`${r.ResourceType}:${r.PhysicalResourceId.replace(/\.$/, '')}`);
    }
  }
  return out;
}

async function ruleSetExists(ses: SESClient, name: string): Promise<boolean> {
  try {
    await ses.send(new DescribeReceiptRuleSetCommand({ RuleSetName: name }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'RuleSetDoesNotExistException') return false;
    throw err;
  }
}

async function identityExists(sesv2: SESv2Client, domain: string): Promise<boolean> {
  try {
    await sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') return false;
    throw err;
  }
}

async function findPublicZone(route53: Route53Client, zoneName: string): Promise<string | undefined> {
  const { HostedZones } = await route53.send(new ListHostedZonesByNameCommand({ DNSName: zoneName, MaxItems: 10 }));
  const zone = (HostedZones ?? []).find((z) => z.Name === `${zoneName}.` && !z.Config?.PrivateZone);
  return zone?.Id?.replace('/hostedzone/', '');
}

async function recordExists(route53: Route53Client, zoneId: string, name: string, type: 'MX' | 'TXT'): Promise<boolean> {
  const { ResourceRecordSets } = await route53.send(
    new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: name, StartRecordType: type, MaxItems: 1 }),
  );
  const r = ResourceRecordSets?.[0];
  return r !== undefined && r.Name === `${name}.` && r.Type === type;
}

function safeRead(): PreflightState | undefined {
  try {
    return readPreflight();
  } catch {
    return undefined;
  }
}
