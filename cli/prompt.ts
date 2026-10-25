import { createInterface } from 'node:readline/promises';

/**
 * Reads one line exactly as typed: at a prompt in a terminal, or the first line of piped stdin.
 * Values read this way never pass through the shell, so `$`, `!`, quotes, and spaces survive.
 */
export async function readLine(
  prompt: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  if (input.isTTY) {
    const rl = createInterface({ input, output, terminal: true });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    rl.once('SIGINT', cancel);
    rl.once('close', cancel);
    try {
      return await rl.question(prompt, { signal: controller.signal });
    } finally {
      rl.off('SIGINT', cancel);
      rl.off('close', cancel);
      rl.close();
    }
  }
  let data = '';
  for await (const chunk of input) {
    data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (data.includes('\n')) break;
  }
  return data.split(/\r?\n/)[0] ?? '';
}

export async function confirmTokenSetup(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) throw new Error('Run qmail setup in a terminal, or explicitly provide --yes --name <name>.');
  const answer = await readLine('Generate and save a custom QMail API token? Requires AWS authentication once to register it; mail commands then use the saved token. [y/N] ', input, output);
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

export async function readSecret(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) throw new Error('Hidden token entry requires a terminal; use INBOX_TOKEN for unattended setup.');
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  process.stderr.write('API token (hidden): ');
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = () => { input.off('data', data); input.off('end', end); };
      const end = () => { cleanup(); reject(new Error('Setup cancelled.')); };
      const data = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003' || char === '\u0004') { end(); return; }
          if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ' && char <= '~') value += char;
          if (value.length > 8192) { end(); return; }
        }
      };
      input.on('data', data);
      input.once('end', end);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stderr.write('\n');
  }
}
