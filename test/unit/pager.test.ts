import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pageThrough, type Page } from '../../cli/ui/pager';
import { stripAnsi } from '../../cli/ui/text';

const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';

/** A source of `count` numbered rows served `size` at a time, recording each fetch. */
function source(count: number, size = 20) {
  const fetched: Array<string | undefined> = [];
  const fetchPage = async (cursor: string | undefined): Promise<Page<number>> => {
    fetched.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const items = Array.from({ length: Math.max(0, Math.min(size, count - start)) }, (_, i) => start + i + 1);
    return { items, next: start + size < count ? String(start + size) : null };
  };
  return { fetchPage, fetched };
}

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, rawMode: [] as boolean[], setRawMode(on: boolean) { this.rawMode.push(on); } });
  let written = '';
  const output = { isTTY: true, columns: 100, rows: 50, write: (s: string) => (written += s) };
  const stderr = { text: '', write(s: string) { this.text += s; } };
  /** The footer line of every frame drawn so far, colors and cursor codes removed. */
  const footers = () =>
    stripAnsi(written)
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
      .split('\n')
      .filter((l) => /^\d+-\d+/.test(l));
  return { input, output, stderr, footers, text: () => written };
}

const render = (items: number[]) => ['ROW', ...items.map((n) => `row ${n}`)];
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('pager', () => {
  it('pages forward and back with the arrow keys, fetching each page once', async () => {
    const t = terminal();
    const s = source(45);
    const done = pageThrough({ fetchPage: s.fetchPage, render, total: async () => 45, empty: 'none', moreHint: () => '', input: t.input, output: t.output, errorOutput: t.stderr });
    await tick();
    for (const key of [RIGHT, RIGHT, RIGHT, LEFT]) {
      t.input.write(key);
      await tick();
    }
    t.input.write('q');
    await done;

    const footers = t.footers();
    expect(footers[0]).toMatch(/^1-20 +← prev/); // first frame is drawn before the count arrives
    expect(footers).toContain('1-20 of 45   ← prev   → next   q quit');
    expect(footers).toContain('21-40 of 45   ← prev   → next   q quit');
    expect(footers).toContain('41-45 of 45   ← prev   → next   q quit');
    // The third → at the last page does nothing; ← goes back to a cached page; q leaves a plain summary.
    expect(footers.slice(-2)).toEqual(['21-40 of 45   ← prev   → next   q quit', '21-40 of 45']);
    expect(s.fetched).toEqual([undefined, '20', '40']);
    expect(t.input.rawMode).toEqual([true, false]);
    expect(t.text().endsWith('\u001b[?25h')).toBe(true); // the cursor is visible again
    expect(t.text()).toContain('row 21');
  });

  it('prints a listing that fits on one page without taking over the keyboard', async () => {
    const t = terminal();
    await pageThrough({ fetchPage: source(3).fetchPage, render, empty: 'none', moreHint: () => '', input: t.input, output: t.output });
    expect(t.text()).toBe('ROW\nrow 1\nrow 2\nrow 3\n');
    expect(t.input.rawMode).toEqual([]);
  });

  it('prints one page and a hint on stderr when output is piped', async () => {
    const t = terminal();
    const piped = { ...t.output, isTTY: false };
    await pageThrough({ fetchPage: source(45).fetchPage, render, empty: 'none', moreHint: (n) => `qmail ls --cursor ${n}`, input: t.input, output: piped, errorOutput: t.stderr });
    expect(t.text().split('\n')).toHaveLength(22); // header, 20 rows, trailing newline
    expect(t.stderr.text).toBe('more: qmail ls --cursor 20\n');
    expect(t.input.rawMode).toEqual([]);
  });

  it('prints the empty message when there is nothing', async () => {
    const t = terminal();
    await pageThrough({ fetchPage: source(0).fetchPage, render, empty: 'no accounts', moreHint: () => '', input: t.input, output: t.output });
    expect(t.text()).toBe('no accounts\n');
  });

  it('never cuts a row wider than the terminal, and erases its wrapped lines on the next frame', async () => {
    const t = terminal();
    const wide = 'x'.repeat(250); // wraps onto 3 lines of a 100-column terminal
    const done = pageThrough({
      fetchPage: source(45).fetchPage,
      render: (items) => ['ROW', ...items.map((n) => (n === 1 ? wide : `row ${n}`))],
      empty: 'none',
      moreHint: () => '',
      input: t.input,
      output: t.output,
    });
    await tick();
    t.input.write(RIGHT);
    await tick();
    t.input.write('q');
    await done;
    expect(t.text()).toContain(wide);
    // Frame 1: header + 20 rows (one wraps to 3 lines) + footer = 24 lines on screen.
    expect(t.text()).toContain('\u001b[24F\u001b[J');
  });

  it('keeps paging after a failed fetch and shows why', async () => {
    const t = terminal();
    const s = source(45);
    let fail = true;
    const fetchPage = async (cursor: string | undefined) => {
      if (cursor && fail) {
        fail = false;
        throw new Error('throttled');
      }
      return s.fetchPage(cursor);
    };
    const done = pageThrough({ fetchPage, render, empty: 'none', moreHint: () => '', input: t.input, output: t.output });
    await tick();
    t.input.write(RIGHT);
    await tick();
    t.input.write(RIGHT);
    await tick();
    t.input.write('q');
    await done;
    const footers = t.footers();
    expect(footers.some((f) => f.includes('could not load the next page: throttled'))).toBe(true);
    expect(footers.at(-1)).toBe('21-40');
  });
});
