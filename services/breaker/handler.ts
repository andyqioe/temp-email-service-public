import { SESClient } from '@aws-sdk/client-ses';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/aws';
import { requireEnv } from '../shared/env';
import { ddbKeys, META } from '../shared/keys';
import { log } from '../shared/log';
import { setReceiving } from '../shared/receiving';

const ses = new SESClient({});
const sns = new SNSClient({});
const stage = requireEnv('STAGE');
const table = requireEnv('TABLE');
const ruleSetName = requireEnv('RULE_SET_NAME');
const ruleName = requireEnv('RULE_NAME');
const alertsTopicArn = requireEnv('ALERTS_TOPIC_ARN');

/** Payload CloudWatch sends to a Lambda alarm action. */
interface AlarmEvent {
  alarmArn?: string;
  alarmData?: {
    alarmName?: string;
    state?: { value?: string; reason?: string; timestamp?: string };
  };
}

/**
 * Auto-pause: an incoming-volume alarm fired, so disable the receipt rule. SES then
 * refuses (and does not bill) mail until someone runs `qmail resume`.
 */
export const handler = async (event: AlarmEvent): Promise<void> => {
  const alarm = event.alarmData?.alarmName ?? 'unknown alarm';
  if (event.alarmData?.state?.value !== 'ALARM') {
    log('info', 'ignoring alarm transition', { alarm, state: event.alarmData?.state?.value });
    return;
  }
  const changed = await setReceiving(ses, ruleSetName, ruleName, false);
  const pausedAt = new Date().toISOString();
  const reason = event.alarmData?.state?.reason ?? '';
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: { pk: ddbKeys.breaker, sk: META, paused: true, pausedAt, alarm, reason, by: 'auto-pause' },
    }),
  );
  log('warn', changed ? 'receiving paused' : 'receiving already paused', { alarm, reason });
  if (changed) {
    await sns.send(
      new PublishCommand({
        TopicArn: alertsTopicArn,
        Subject: `[ses-inbox ${stage}] Receiving paused by auto-pause`.slice(0, 100),
        Message: [
          `Incoming mail for stage "${stage}" crossed an auto-pause limit, so receipt rule ${ruleName} was disabled at ${pausedAt}.`,
          `While paused, SES refuses mail for this stage during the SMTP conversation and does not bill for it.`,
          `Legitimate senders are refused too.`,
          ``,
          `Alarm: ${alarm}`,
          `Reason: ${reason}`,
          ``,
          `Investigate with:  qmail usage --stage ${stage}`,
          `Resume with:       qmail resume --stage ${stage}`,
        ].join('\n'),
      }),
    );
  }
};
