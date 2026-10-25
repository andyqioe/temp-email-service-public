import { DescribeReceiptRuleCommand, UpdateReceiptRuleCommand, type SESClient } from '@aws-sdk/client-ses';

/**
 * Enables or disables our receipt rule. While it is disabled no enabled rule matches our
 * recipients, so SES refuses the mail during the SMTP conversation and bills nothing.
 * Returns true when the rule changed.
 */
export async function setReceiving(ses: SESClient, ruleSetName: string, ruleName: string, enabled: boolean): Promise<boolean> {
  const { Rule } = await ses.send(new DescribeReceiptRuleCommand({ RuleSetName: ruleSetName, RuleName: ruleName }));
  if (!Rule) throw new Error(`receipt rule ${ruleSetName}/${ruleName} not found`);
  if ((Rule.Enabled ?? false) === enabled) return false;
  await ses.send(new UpdateReceiptRuleCommand({ RuleSetName: ruleSetName, Rule: { ...Rule, Enabled: enabled } }));
  return true;
}

export async function isReceiving(ses: SESClient, ruleSetName: string, ruleName: string): Promise<boolean | undefined> {
  try {
    const { Rule } = await ses.send(new DescribeReceiptRuleCommand({ RuleSetName: ruleSetName, RuleName: ruleName }));
    return Rule?.Enabled ?? false;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'RuleDoesNotExistException' || name === 'RuleSetDoesNotExistException') return undefined;
    throw err;
  }
}
