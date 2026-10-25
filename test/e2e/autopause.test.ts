import { CloudWatchClient, DescribeAlarmsCommand, PutMetricAlarmCommand, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import { SESClient } from '@aws-sdk/client-ses';
import { describe, expect, it } from 'vitest';
import { breakerState, pause, resume } from '../../cli/admin';
import { preflight } from '../../cli/preflight';
import { stageContext } from '../../cli/stack';
import { isReceiving } from '../../services/shared/receiving';
import { address, api, e2e, marker, send, sleep, waitFor, waitForListing } from './support';

/**
 * Runs in its own vitest project, after everything else, because it switches receiving
 * off for the whole stage.
 */
describe('auto-pause', () => {
  it('pauses receiving when the volume alarm fires, refuses mail while paused, and resumes', async () => {
    const ctx = await stageContext(e2e().stage);
    const cw = new CloudWatchClient({ region: e2e().region });
    const ses = new SESClient({ region: e2e().region });
    const receiving = () => isReceiving(ses, ctx.outputs.RuleSetName, ctx.outputs.RuleName);
    const [original] = (await cw.send(new DescribeAlarmsCommand({ AlarmNames: [ctx.outputs.HourlyAlarmName] }))).MetricAlarms ?? [];
    if (!original) throw new Error('hourly auto-pause alarm not found');
    expect(await receiving()).toBe(true);

    try {
      // Real traffic this hour, then a cap below it: the same path a real flood takes.
      const to = address('autopause-');
      for (const m of [marker(), marker()]) {
        await send({ to: [to], subject: `Before pause ${m}`, text: 'x' });
        await waitForListing(to, m);
      }
      await cw.send(new PutMetricAlarmCommand({ ...alarmInput(original), Threshold: 1 }));
      await waitFor('the breaker to disable the receipt rule', async () => ((await receiving()) === false ? true : undefined), {
        timeoutMs: 15 * 60_000,
        intervalMs: 15_000,
      });
      expect(await breakerState(ctx)).toMatchObject({ paused: true, by: 'auto-pause', alarm: ctx.outputs.HourlyAlarmName });

      // While paused, SES refuses mail during SMTP: it never reaches the bucket. SES applies a rule
      // change after a short delay, so mail sent in the first moments may still arrive: probe until
      // one is refused, then check that the pause holds for the next message too.
      const delivered = async (subject: string) => {
        await sleep(60_000); // accepted mail is listed within seconds
        return (await api().listInbox(to)).messages.some((x) => x.subject.includes(subject));
      };
      let accepted = 0;
      for (const until = Date.now() + 10 * 60_000; ; accepted++) {
        const probe = `While paused ${marker()}`;
        await send({ to: [to], subject: probe, text: 'x' });
        if (!(await delivered(probe))) break;
        if (Date.now() > until) throw new Error(`SES still accepted mail 10 minutes after the rule was disabled (${accepted + 1} probes)`);
      }
      if (accepted > 0) console.log(`auto-pause: ${accepted} probe(s) arrived before SES applied the disabled rule`);
      const held = `Still paused ${marker()}`;
      await send({ to: [to], subject: held, text: 'x' });
      expect(await delivered(held)).toBe(false);

      // A deploy while paused must not switch receiving back on.
      const { state } = await preflight(e2e().stage);
      expect(state.stages[e2e().stage]?.ruleEnabled).toBe(false);
    } finally {
      await cw.send(new PutMetricAlarmCommand(alarmInput(original)));
      await resume(ctx);
    }

    expect(await receiving()).toBe(true);
    const after = marker();
    const to = address('autopause-after-');
    await send({ to: [to], subject: `After resume ${after}`, text: 'x' });
    await waitForListing(to, after);

    // Manual pause and resume behave the same way.
    expect(await pause(ctx)).toBe(true);
    expect(await receiving()).toBe(false);
    expect(await resume(ctx)).toBe(true);
    expect(await receiving()).toBe(true);
  });
});

function alarmInput(a: MetricAlarm) {
  return {
    AlarmName: a.AlarmName!,
    AlarmDescription: a.AlarmDescription,
    ActionsEnabled: a.ActionsEnabled,
    AlarmActions: a.AlarmActions,
    OKActions: a.OKActions,
    InsufficientDataActions: a.InsufficientDataActions,
    Namespace: a.Namespace,
    MetricName: a.MetricName,
    Dimensions: a.Dimensions,
    Statistic: a.Statistic,
    Period: a.Period,
    EvaluationPeriods: a.EvaluationPeriods!,
    DatapointsToAlarm: a.DatapointsToAlarm,
    Threshold: a.Threshold,
    ComparisonOperator: a.ComparisonOperator!,
    TreatMissingData: a.TreatMissingData,
  };
}
