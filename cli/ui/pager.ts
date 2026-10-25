import { emitKeypressEvents } from 'node:readline';
import { color, terminalWidth, visibleLength } from './text';

export interface Page<T> {
  items: T[];
  /** Cursor for the page after this one, or null on the last page. */
  next: string | null;
}

type Key = { name?: string; ctrl?: boolean; sequence?: string };
type KeyListener = (str: string | undefined, key: Key | undefined) => void;

interface Input {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  on(event: 'keypress', listener: KeyListener): unknown;
  off(event: 'keypress', listener: KeyListener): unknown;
  resume(): unknown;
  pause(): unknown;
}

interface Output {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export interface PagerOptions<T> {
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>;
  /** Lines for one page (header included), fitted to `width`. */
  render: (items: T[], width: number) => string[];
  /** Counts everything across all pages; only called for an interactive listing. */
  total?: () => Promise<number | undefined>;
  /** Printed when there is nothing at all. */
  empty: string;
  /** The command that continues a non-interactive listing, e.g. `qmail ls a@b --cursor X`. */
  moreHint: (next: string) => string;
  input?: Input;
  output?: Output;
  /** Where hints for scripts go (stderr), so stdout stays pure data. */
  errorOutput?: { write(s: string): unknown };
}

/**
 * Shows a listing one page at a time. In a terminal, ←/→ (or h/l, PgUp/PgDn) move between
 * pages and q quits, redrawing in place so the last page stays on screen. A listing that fits
 * on one page just prints. Piped output prints the first page and a command for the next.
 * Pages already seen are kept, so going back never refetches.
 */
export async function pageThrough<T>(opts: PagerOptions<T>): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const errorOutput = opts.errorOutput ?? process.stderr;
  const width = () => terminalWidth(output.columns);

  const interactive = input.isTTY === true && output.isTTY === true;
  // Count alongside the first page; a failed count only leaves the total out of the footer.
  const counting = interactive ? opts.total?.().catch(() => undefined) : undefined;
  const first = await opts.fetchPage(undefined);
  if (first.items.length === 0) {
    output.write(`${opts.empty}\n`);
    return;
  }
  if (!first.next || !interactive) {
    output.write(`${opts.render(first.items, width()).join('\n')}\n`);
    if (first.next) errorOutput.write(`more: ${opts.moreHint(first.next)}\n`);
    return;
  }

  const pages: Array<Page<T>> = [first];
  let index = 0;
  let total: number | undefined;
  let status = '';
  let drawn = 0;
  let done = false;

  const footer = (final: boolean) => {
    const start = pages.slice(0, index).reduce((n, p) => n + p.items.length, 0) + 1;
    const end = start + pages[index]!.items.length - 1;
    const range = `${start}-${end}${total !== undefined ? ` of ${total}` : ''}`;
    if (final) return color.dim(range);
    const hasNext = index + 1 < pages.length || pages[index]!.next !== null;
    const key = (on: boolean, label: string) => (on ? label : color.dim(label));
    return [color.bold(range), key(index > 0, '← prev'), key(hasNext, '→ next'), 'q quit', status && color.yellow(status)]
      .filter(Boolean)
      .join('   ');
  };

  const draw = (final = false, resized = false) => {
    const w = width();
    // Lines are never cut: a row wider than the terminal wraps, and the wrap is counted so the
    // next frame still erases exactly this one (columns like passwords must stay whole).
    const lines = [...opts.render(pages[index]!.items, w), footer(final)];
    // Move back to the top of the previous frame and clear it; if that frame no longer fits the
    // screen, or the terminal reflowed it on resize, start over at the top instead.
    if (drawn > 0) {
      const restart = resized || (output.rows !== undefined && output.rows > 0 && drawn >= output.rows);
      output.write(restart ? '\u001b[2J\u001b[H' : `\u001b[${drawn}F\u001b[J`);
    }
    output.write(`${lines.join('\n')}\n`);
    drawn = lines.reduce((n, l) => n + Math.max(1, Math.ceil(visibleLength(l) / w)), 0);
  };

  void counting?.then((n) => {
    total = n;
    if (drawn > 0 && !done) draw();
  });

  emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
  input.setRawMode?.(true);
  input.resume();
  const showCursor = () => output.write('\u001b[?25h');
  output.write('\u001b[?25l'); // hidden while paging; shown again even if the process exits mid-page
  process.once('exit', showCursor);
  const onResize = () => draw(false, true);
  output.on?.('resize', onResize);

  try {
    draw();
    await new Promise<void>((resolve) => {
      let busy = false;
      const onKey: KeyListener = (str, key) => {
        const name = key?.name ?? str;
        if (name === 'q' || name === 'escape' || (key?.ctrl && name === 'c')) {
          input.off('keypress', onKey);
          resolve();
          return;
        }
        if (busy) return;
        if (name === 'left' || name === 'h' || name === 'pageup' || name === 'p') {
          if (index > 0) {
            index--;
            status = '';
            draw();
          }
        } else if (name === 'right' || name === 'l' || name === 'pagedown' || name === 'n' || name === 'space') {
          if (index + 1 < pages.length) {
            index++;
            status = '';
            draw();
            return;
          }
          const next = pages[index]!.next;
          if (!next) return;
          busy = true;
          status = 'loading…';
          draw();
          opts.fetchPage(next).then(
            (page) => {
              busy = false;
              status = '';
              if (page.items.length > 0) {
                pages.push(page);
                index++;
              } else {
                pages[index] = { ...pages[index]!, next: null };
              }
              draw();
            },
            (err: unknown) => {
              busy = false;
              status = `could not load the next page: ${err instanceof Error ? err.message : String(err)}`;
              draw();
            },
          );
        }
      };
      input.on('keypress', onKey);
    });
    draw(true);
  } finally {
    done = true;
    output.off?.('resize', onResize);
    process.off('exit', showCursor);
    showCursor();
    input.setRawMode?.(false);
    input.pause();
  }
}
