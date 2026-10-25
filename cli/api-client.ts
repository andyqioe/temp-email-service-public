import { setTimeout as delay } from 'node:timers/promises';
import { validateApiUrl, type ApiTarget } from './local-config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ListingEntry {
  id: string;
  receivedAt: string;
  from: string;
  subject: string;
  snippet: string;
  size: number;
  attachments: number;
  spam: boolean;
  virus: boolean;
  parseError: boolean;
  address?: string;
  tag?: string;
  recipients?: string[];
  cursor: string;
  indexedCursor: string;
}

export interface ParserStateView {
  status: 'pending' | 'ok' | 'error';
  attempts: number;
  updatedAt: string;
  error?: string;
  output?: unknown;
}

export interface MessageView {
  id: string;
  receivedAt: string;
  size: number;
  recipients: string[];
  envelopeFrom: string;
  subject: string;
  from: Array<{ name: string; address: string }>;
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  replyTo: Array<{ name: string; address: string }>;
  date: string | null;
  headerMessageId: string | null;
  text: string | null;
  html: string | null;
  headers: Array<[string, string]>;
  attachments: Array<{ index: number; filename?: string; contentType: string; size: number; inline: boolean; downloadable: boolean }>;
  verdicts: Record<string, string>;
  spam: boolean;
  virus: boolean;
  parseError: string | null;
  parsers: Record<string, ParserStateView>;
}

export interface PresignedUrl {
  url: string;
  expiresIn: number;
}

/** Thin typed client for the ses-inbox HTTP API. */
export class InboxApi {
  constructor(private readonly target: Pick<ApiTarget, 'apiUrl' | 'token'>, private readonly signal?: AbortSignal) {}

  listInbox(address: string, q: { limit?: number; before?: string; since?: string } = {}) {
    return this.request<{ messages: ListingEntry[]; nextBefore?: string | null; nextSince?: string }>(
      'GET',
      `/inboxes/${encodeURIComponent(address)}/messages`,
      q,
    );
  }

  feed(q: { date?: string; domain?: string; limit?: number; before?: string } = {}) {
    return this.request<{ date: string; domain: string; messages: ListingEntry[]; nextBefore: string | null }>('GET', '/feed', q);
  }

  message(id: string) {
    return this.request<MessageView>('GET', `/messages/${encodeURIComponent(id)}`);
  }

  rawUrl(id: string) {
    return this.request<PresignedUrl>('GET', `/messages/${encodeURIComponent(id)}/raw`);
  }

  attachmentUrl(id: string, index: number) {
    return this.request<PresignedUrl & { filename: string | null; contentType: string; size: number }>(
      'GET',
      `/messages/${encodeURIComponent(id)}/attachments/${index}`,
    );
  }

  delete(id: string) {
    return this.request<{ deleted: string }>('DELETE', `/messages/${encodeURIComponent(id)}`);
  }

  deleteInbox(address: string) {
    return this.request<{ address: string; deleted: number; more: boolean }>('DELETE', `/inboxes/${encodeURIComponent(address)}/messages`);
  }

  reparse(id: string, parser?: string) {
    return this.request<{ id: string; enqueued: string[] }>('POST', `/messages/${encodeURIComponent(id)}/reparse`, { parser });
  }

  async request<T>(method: string, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(validateApiUrl(this.target.apiUrl) + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { method, headers: { authorization: `Bearer ${this.target.token}` }, signal: this.signal, redirect: 'error' });
      // API Gateway throttling: back off and retry a few times.
      if (res.status === 429 && attempt < 5) {
        await res.body?.cancel();
        await delay(250 * 2 ** attempt, undefined, { signal: this.signal });
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
      this.signal?.throwIfAborted();
      if (!res.ok) {
        throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
      }
      return body;
    }
  }
}
