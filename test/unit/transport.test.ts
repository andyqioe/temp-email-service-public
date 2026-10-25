import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { InboxApi } from '../../cli/api-client';
import { validateApiUrl } from '../../cli/local-config';

test.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#secret', 'file:///etc/passwd'])('rejects unsafe API target %s', (url) => {
  expect(() => validateApiUrl(url)).toThrow();
});

test('allows HTTPS and explicit loopback HTTP fixtures', () => {
  expect(validateApiUrl('https://example.com/')).toBe('https://example.com');
  expect(validateApiUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
});

test('does not follow redirects or echo remote error values', async () => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/target' }); res.end(); }
    else if (req.url === '/target') { redirected++; res.end('{}'); }
    else { res.writeHead(403); res.end(JSON.stringify({ error: { code: 'sensitive-code', message: 'sensitive-token' } })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const api = new InboxApi({ apiUrl: `http://127.0.0.1:${port}`, token: 'synthetic-token' });
  try {
    await expect(api.request('GET', '/redirect')).rejects.toThrow();
    expect(redirected).toBe(0);
    await expect(api.request('GET', '/failure')).rejects.toMatchObject({ code: 'http_error', message: 'HTTP 403' });
  } finally { server.closeAllConnections(); server.close(); }
});
