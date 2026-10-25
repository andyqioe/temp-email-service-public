import type { Section, UsageData } from './insights';
import { bytes, color, count, exact, fit, ms, money, relative, section, sparkline, table, terminalWidth, tone } from './ui/text';

/** Renders `qmail usage` for the terminal. Pure: takes collected data, returns lines. */
export function renderUsage(d: UsageData, width = terminalWidth()): string[] {
  const out: string[] = [];
  const kv = (label: string, value: string) => out.push(fit(`  ${color.dim(label.padEnd(16))}${value}`.trimEnd(), width));
  const block = <T>(title: string, s: Section<T>, body: (data: T) => void) => {
    out.push('', section(title, width));
    if (s.ok) body(s.data);
    else out.push(`  ${tone('warn', `unavailable: ${s.error}`)}`);
  };

  // Times are relative to when the data was collected, so a frame never mixes two clocks.
  const asOf = new Date(d.generatedAt);
  out.push(color.bold(`ses-inbox · ${d.stage} · ${d.region}`) + color.dim(`   range ${d.range} · ${d.generatedAt.replace('T', ' ').slice(0, 16)} UTC`));
  if (d.header.ok) {
    const h = d.header.data;
    const role = describePrincipal(h.arn);
    const sso = h.ssoExpiresAt ? ` · SSO ${new Date(h.ssoExpiresAt) > asOf ? `expires ${relative(new Date(h.ssoExpiresAt), asOf)}` : tone('bad', 'expired')}` : '';
    out.push(color.dim(fit(`account ${h.account} · ${role}${h.profile ? ` · profile ${h.profile}` : ''}${sso}`, width)));
  }

  block('Receiving', d.receiving, (r) => {
    const state =
      r.ruleEnabled === undefined ? tone('bad', 'rule missing') : r.ruleEnabled ? tone('ok', 'on') : tone('bad', 'PAUSED');
    const pausedBy = r.ruleEnabled === false && r.breaker?.paused ? color.dim(` by ${r.breaker.by ?? '?'}${r.breaker.at ? ` ${relative(new Date(r.breaker.at), asOf)}` : ''}`) : '';
    kv('receiving', `${state}${pausedBy}  ${color.dim(`rule ${r.rule}`)}`);
    kv('auto-pause', `pauses above ${exact(r.autoPause.perHour)}/hour or ${exact(r.autoPause.perDay)}/day`);
    kv('accepted', `${count(r.received)} in ${d.range}  ${color.cyan(sparkline(r.series))}  ${color.dim(`per ${r.seriesUnit}`)}`);
    kv('publish fails', r.publishFailures > 0 ? tone('bad', count(r.publishFailures)) : tone('ok', '0'));
    kv('blocked IPs', r.blockedIps.length ? r.blockedIps.join(', ') : color.dim('none'));
    kv('SES account', r.sesProduction ? 'production' : `sandbox ${color.dim('(limits sending only; receiving is unaffected)')}`);
  });

  block(`Inboxes (mail kept ${d.inboxes.ok ? d.inboxes.data.retentionHours : '?'}h)`, d.inboxes, (i) => {
    kv('messages', count(i.messages));
    kv('addresses', `${count(i.addresses)} ${color.dim('with mail right now')}`);
  });

  block('Accounts', d.accounts, (a) => {
    kv('registered', `${count(a.total)} ${color.dim(`(${a.withPassword} with a password)`)}`);
    if (a.byService.length) kv('by service', a.byService.map((s) => `${s.service} ${s.count}`).join(' · '));
  });

  block('Parsers', d.parsers, (p) => {
    if (p.rules.length === 0) return void out.push(color.dim('  no parser rules'));
    const rows = p.rules.map((r) => {
      const runs = p.runs[r.name];
      const errors = runs?.error ?? 0;
      return [r.name, r.module, count(runs?.ok ?? 0), errors > 0 ? tone('bad', count(errors)) : '0', `${r.timeoutS}s`, r.match];
    });
    for (const line of table(['NAME', 'MODULE', 'OK', 'ERRORS', 'TIMEOUT', 'MATCH'], rows, width - 2)) out.push(`  ${line}`);
    if (p.runsNote) out.push(color.dim(`  runs: ${p.runsNote}`));
  });

  block('Lambda', d.lambdas, (l) => {
    const limit = l.concurrencyLimit ?? 0;
    const peakTone = limit && (l.peakConcurrency ?? 0) >= limit ? 'bad' : 'plain';
    const runtimes = [
      ...new Set(l.functions.filter((f) => !f.helper).map((f) => `${(f.runtime ?? '?').replace(/^nodejs(\d+)\.x$/, 'node $1')} ${f.arch ?? ''}`.trim())),
    ];
    const note = limit > 0 && limit <= 10 ? color.dim(' (new-account default; quota increase requested)') : '';
    kv('concurrency', `limit ${exact(limit)} · peak ${tone(peakTone, count(l.peakConcurrency))}${note}`);
    kv('runtime', runtimes.join(', '));
    const rows = l.functions.map((f) => [
      f.helper ? color.dim(`${f.name} (${f.stack === 'shared' ? 'shared' : 'helper'})`) : f.name,
      `${f.memoryMb ? (f.memoryMb >= 1024 ? `${f.memoryMb / 1024} GB` : `${f.memoryMb} MB`) : '-'} · ${f.timeoutS ?? '-'}s`,
      count(f.invocations),
      (f.errors ?? 0) > 0 ? tone('bad', count(f.errors)) : '0',
      (f.throttles ?? 0) > 0 ? tone('warn', count(f.throttles)) : '0',
      ms(f.p95Ms),
      bytes(f.codeBytes),
    ]);
    for (const line of table(['FUNCTION', 'MEMORY · TIMEOUT', 'CALLS', 'ERRORS', 'THROTTLED', 'P95', 'CODE'], rows, width - 2)) {
      out.push(`  ${line}`);
    }
  });

  block('Queue', d.queue, (q) => {
    kv('ingest', `${q.waiting} waiting · ${q.inFlight} in flight`);
    kv('dead letters', q.dlq > 0 ? tone('bad', `${q.dlq}  (qmail repair dlq after fixing the cause)`) : tone('ok', '0'));
  });

  block('Storage', d.storage, (s) => {
    const s3 =
      s.s3.bytes === undefined
        ? color.dim('pending (S3 publishes storage metrics once a day)')
        : `${bytes(s.s3.bytes)} · ${count(s.s3.objects)} objects ${color.dim(`(as of ${s.s3.asOf}; includes deleted versions kept 1 day)`)}`;
    kv('mail bucket', s3);
    kv('index table', `~${count(s.index.items)} items · ${bytes(s.index.bytes)} ${color.dim('(DynamoDB estimate, refreshed every ~6h)')}`);
    const backups = s.accounts.backups === 'ENABLED' ? tone('ok', 'backups on') : tone('warn', `backups ${s.accounts.backups ?? 'unknown'}`);
    kv('accounts table', `~${count(s.accounts.items)} items · ${bytes(s.accounts.bytes)} · ${backups}`);
  });

  block('HTTP API', d.api, (a) => {
    kv('requests', `${count(a.requests)} · 4xx ${a.errors4xx > 0 ? tone('warn', count(a.errors4xx)) : '0'} · 5xx ${a.errors5xx > 0 ? tone('bad', count(a.errors5xx)) : '0'} · p95 ${ms(a.p95Ms)}`);
  });

  block('Alarms', d.alarms, (alarms) => {
    const bad = alarms.filter((a) => a.state !== 'OK');
    kv('state', bad.length === 0 ? tone('ok', `all ${alarms.length} OK`) : bad.map((a) => tone(a.state === 'ALARM' ? 'bad' : 'warn', `${a.name}: ${a.state}`)).join(' · '));
  });

  block('Cost (month to date, whole account)', d.cost, (c) => {
    if (c.limit === undefined) kv('budget', color.dim('no monthlyBudgetUsd configured'));
    else {
      const used = c.actual ?? 0;
      const t = used >= c.limit ? 'bad' : used >= c.limit * 0.8 ? 'warn' : 'ok';
      kv('spent', `${tone(t, money(c.actual))} of ${money(c.limit)} budget${c.forecast !== undefined ? ` · forecast ${money(c.forecast)}` : ''} ${color.dim('(updated a few times a day)')}`);
    }
    if (c.byServiceError) {
      kv('by service', tone('warn', c.byServiceError));
    } else if (c.byService) {
      if (c.byService.length === 0) kv('by service', color.dim('nothing billed yet'));
      for (const s of c.byService.slice(0, 8)) kv('', `${money(s.amount).padStart(8)}  ${s.service}`);
    } else {
      kv('by service', color.dim('add --cost for a Cost Explorer breakdown ($0.01 per run)'));
    }
  });

  return out;
}

/** "arn:aws:sts::1:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/me" -> "AdministratorAccess (me)" */
export function describePrincipal(arn: string): string {
  const m = /:assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  if (!m) return arn.split(':').at(-1) ?? arn;
  const role = /^AWSReservedSSO_(.+)_[0-9a-f]{16}$/.exec(m[1]!)?.[1] ?? m[1]!;
  return `${role} (${m[2]})`;
}
