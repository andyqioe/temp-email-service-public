import { parentPort, Worker, workerData } from 'node:worker_threads';
import { PARSER_MODULES } from '../../parsers/registry';

/** Heap limit for one parser run. The ingest Lambda has 1 GB in total. */
const WORKER_HEAP_MB = 256;

export class ParserTimeout extends Error {
  override name = 'ParserTimeout';
}

/**
 * Runs one parser module in a worker thread built from this same bundle. A timeout
 * terminates the thread, which (unlike a Promise.race) also stops code that never yields,
 * such as a catastrophic regex on hostile input.
 */
export function runParserInWorker(module: string, input: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { module, input },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new ParserTimeout(`parser timed out after ${timeoutMs} ms`))), timeoutMs);
    worker.on('message', (m: { ok: boolean; output?: unknown; error?: string }) =>
      finish(() => (m.ok ? resolve(m.output) : reject(new Error(m.error ?? 'parser failed')))),
    );
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => finish(() => reject(new Error(`parser worker exited with code ${code}`))));
  });
}

/** Entry point inside the worker thread (the bundle calls this when it is not the main thread). */
export async function parserWorkerMain(): Promise<void> {
  const { module, input } = workerData as { module: string; input: unknown };
  try {
    const fn = (PARSER_MODULES as Record<string, (event: unknown) => Promise<unknown>>)[module];
    if (!fn) throw new Error(`unknown parser module ${module}`);
    parentPort!.postMessage({ ok: true, output: await fn(input) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}
