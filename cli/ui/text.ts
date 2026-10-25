/** Terminal text helpers: ANSI colors (off for NO_COLOR or when not a TTY), widths, and units. */

const enabled = () => !process.env.NO_COLOR && process.stdout.isTTY === true;
const wrap = (open: number, close: number) => (s: string) => (enabled() ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export type Tone = 'ok' | 'warn' | 'bad' | 'plain';
export function tone(t: Tone, s: string): string {
  return t === 'ok' ? color.green(s) : t === 'warn' ? color.yellow(s) : t === 'bad' ? color.red(s) : s;
}

const ANSI = /\u001b\[[0-9;]*m/g;
export const visibleLength = (s: string) => stripAnsi(s).length;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)));
}

/** Truncates to a visible width, keeping ANSI sequences balanced by dropping color when cut. */
export function fit(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  const plain = stripAnsi(s);
  return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`;
}

export function terminalWidth(columns = process.stdout.columns): number {
  // 0 means the terminal did not report a size (for example a fresh pseudo-terminal).
  const cols = columns || Number(process.env.COLUMNS);
  return Math.max(60, Math.min(cols && cols > 0 ? cols : 100, 160));
}

const BLOCKS = '▁▂▃▄▅▆▇█';
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) return BLOCKS[0]!.repeat(values.length);
  return values.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)))]).join('');
}

export function bytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Exact integer with thousands separators, for configured limits. */
export function exact(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function count(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function money(n: number | undefined): string {
  return n === undefined || Number.isNaN(n) ? '-' : `$${n.toFixed(2)}`;
}

export function ms(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-';
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

/** "in 5h 12m" / "3m ago" */
export function relative(target: Date, now = new Date()): string {
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const span = h >= 48 ? `${Math.floor(h / 24)}d` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/**
 * Renders rows as aligned columns, shrinking the widest column until the table fits `width`.
 * Columns in `keep` (for example an id you copy from the output) are never shrunk; a column
 * with weight 2 keeps about twice the width of a weight-1 column when space runs out.
 */
export function table(
  headers: string[],
  rows: string[][],
  width = terminalWidth(),
  opts: { keep?: number[]; weights?: number[] } = {},
): string[] {
  const all = [headers.map((h) => color.dim(h)), ...rows];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => visibleLength(r[c] ?? ''))));
  const gap = 2;
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const shrinkable = (c: number) => !opts.keep?.includes(c);
  const load = (c: number) => widths[c]! / (opts.weights?.[c] ?? 1);
  while (total() > width) {
    const widest = widths.reduce((best, _, c) => (shrinkable(c) && (best === -1 || load(c) > load(best)) ? c : best), -1);
    if (widest === -1 || widths[widest]! <= 4) break;
    widths[widest]!--;
  }
  return all.map((r) =>
    r
      .map((cell, c) => (c === r.length - 1 ? fit(cell, widths[c]!) : padEnd(fit(cell, widths[c]!), widths[c]!)))
      .join(' '.repeat(gap))
      .trimEnd(),
  );
}

export function section(title: string, width = terminalWidth()): string {
  const label = ` ${title} `;
  return color.bold(`──${label}${'─'.repeat(Math.max(2, width - label.length - 2))}`);
}
