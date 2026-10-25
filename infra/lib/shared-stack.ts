import { CustomResource, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnReceiptRuleSet } from 'aws-cdk-lib/aws-ses';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { InboxConfig } from '../../config/schema';
import { nodeFunction } from './lambda';

export interface SharedStackProps extends StackProps {
  config: InboxConfig;
  /** Create and activate `config.ruleSetName`. False when another rule set is already active. */
  ownRuleSet: boolean;
}

/**
 * Account-and-region-wide resources used by every stage: the receipt rule set (only one can
 * be active per region, so stages add their rules to it) and the optional budget alert.
 */
export class SharedStack extends Stack {
  constructor(scope: Construct, id: string, props: SharedStackProps) {
    super(scope, id, props);
    const { config } = props;

    if (props.ownRuleSet) {
      const ruleSet = new CfnReceiptRuleSet(this, 'RuleSet', { ruleSetName: config.ruleSetName });

      const onEvent = nodeFunction(this, 'ActivatorFn', {
        entry: 'services/ruleset-activator/handler.ts',
        memoryMb: 256,
        timeoutSeconds: 60,
        description: 'Activates the ses-inbox receipt rule set',
      });
      onEvent.addToRolePolicy(
        new PolicyStatement({
          actions: ['ses:DescribeActiveReceiptRuleSet', 'ses:SetActiveReceiptRuleSet'],
          resources: ['*'],
        }),
      );
      const provider = new Provider(this, 'ActivatorProvider', { onEventHandler: onEvent });
      const activation = new CustomResource(this, 'Activation', {
        serviceToken: provider.serviceToken,
        properties: { RuleSetName: config.ruleSetName },
      });
      // Deactivation must run before the rule set is deleted (SES refuses to delete an active set).
      activation.node.addDependency(ruleSet);
    }

    if (config.monthlyBudgetUsd !== undefined) {
      new CfnBudget(this, 'Budget', {
        budget: {
          budgetName: `${config.project}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
            subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
            subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
          },
        ],
      });
    }
  }
}
