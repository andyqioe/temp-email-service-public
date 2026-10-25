import { describe, expect, it } from 'vitest';
import { accountTable } from '../../cli/account-view';
import type { Account } from '../../cli/accounts';
import { stripAnsi } from '../../cli/ui/text';

const account: Account = {
  email: 'signup-maria.lopez84@in.example.com',
  service: 'jagex',
  username: 'signup-maria.lopez84@in.example.com',
  password: 'R..$ecret!2026 "quoted"',
  url: 'https://account.jagex.com/en-GB/login?returnTo=%2Faccount',
  createdAt: '2026-09-22T22:51:27.209Z',
  updatedAt: '2026-09-22T22:51:27.209Z',
};

describe('account table', () => {
  it.each([60, 80, 100, 160])('shows email, service, username, and password whole at %i columns', (width) => {
    const [header, row] = accountTable([account], width).map(stripAnsi);
    expect(header).toMatch(/^EMAIL\s+SERVICE\s+USERNAME\s+PASSWORD\s+ADDED(\s+URL)?$/);
    expect(row).toContain(`${account.email}  jagex    ${account.username}  ${account.password}  2026-09-22`);
  });

  it('leaves out a URL there is no room for, instead of showing a stub', () => {
    const [header] = accountTable([account], 100).map(stripAnsi);
    expect(header).not.toContain('URL');
  });

  it('shortens the URL, which comes last, when there is some room', () => {
    const short = { ...account, email: 'bo@in.example.com', username: 'bo', password: 'pw12345678' };
    const [header, row] = accountTable([short], 100).map(stripAnsi);
    expect(header).toMatch(/URL$/);
    expect(row!).toMatch(/https:\/\/account\.jagex\.com\S*…$/);
    expect(row!.length).toBeLessThanOrEqual(100);
    const [, wide] = accountTable([account], 200).map(stripAnsi);
    expect(wide!.endsWith(account.url!)).toBe(true);
  });
});
