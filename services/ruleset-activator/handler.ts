import { DescribeActiveReceiptRuleSetCommand, SESClient, SetActiveReceiptRuleSetCommand } from '@aws-sdk/client-ses';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const ses = new SESClient({});

/**
 * Custom resource (Provider framework) that activates our receipt rule set.
 * CloudFormation has no way to activate a rule set, and only one can be active per region.
 * - Create/Update: activate ours, but refuse to replace a different active set.
 * - Delete: deactivate only if ours is still the active one. Calling
 *   SetActiveReceiptRuleSet with no name turns off receiving for the whole region,
 *   so it must never run when another set is active.
 */
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const name = String(event.ResourceProperties.RuleSetName);
  const active = (await ses.send(new DescribeActiveReceiptRuleSetCommand({}))).Metadata?.Name;

  if (event.RequestType === 'Delete') {
    if (active === name) await ses.send(new SetActiveReceiptRuleSetCommand({}));
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  if (active && active !== name) {
    throw new Error(
      `Receipt rule set "${active}" is already active in this region. ` +
        `Refusing to replace it; rerun preflight so the stages add their rules to "${active}" instead.`,
    );
  }
  if (active !== name) await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: name }));
  return { PhysicalResourceId: `active-receipt-rule-set:${name}`, Data: { RuleSetName: name } };
};
