import { randomInt } from 'node:crypto';

// Common, plausible-looking names so generated addresses pass "looks like a person" checks.
const FIRST = [
  'alex', 'amelia', 'andrea', 'anna', 'ben', 'carla', 'chris', 'claire', 'daniel', 'david', 'diana', 'elena', 'emily',
  'emma', 'eric', 'ethan', 'grace', 'hannah', 'henry', 'isabel', 'jack', 'james', 'jasmine', 'jason', 'julia', 'kate',
  'kevin', 'laura', 'leo', 'lily', 'lucas', 'lucy', 'maria', 'mark', 'maya', 'megan', 'michael', 'mila', 'nathan',
  'nina', 'noah', 'olivia', 'oscar', 'paul', 'rachel', 'ryan', 'sam', 'sara', 'sofia', 'thomas', 'victor', 'zoe',
];
const LAST = [
  'adams', 'allen', 'bailey', 'baker', 'bell', 'brooks', 'brown', 'carter', 'clark', 'collins', 'cook', 'cooper',
  'davis', 'diaz', 'evans', 'fisher', 'foster', 'garcia', 'gray', 'green', 'hall', 'harris', 'hayes', 'hill', 'hughes',
  'jones', 'kelly', 'kim', 'lee', 'lewis', 'lopez', 'martin', 'miller', 'moore', 'morgan', 'murphy', 'nguyen', 'parker',
  'patel', 'perez', 'reed', 'rivera', 'ross', 'scott', 'shaw', 'smith', 'taylor', 'turner', 'walker', 'ward', 'young',
];

const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)]!;

/** e.g. "maria.lopez84", or "signup-maria.lopez84" with a prefix. About 270k combinations before the prefix. */
export function randomLocalPart(prefix?: string): string {
  const sep = pick(['.', '', '_']);
  const local = `${pick(FIRST)}${sep}${pick(LAST)}${randomInt(10, 100)}`;
  return prefix ? `${prefix}${local}` : local;
}
