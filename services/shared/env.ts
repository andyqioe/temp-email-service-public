export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`missing environment variable ${name}`);
  return value;
}

export function jsonEnv<T>(name: string, fallback?: T): T {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing environment variable ${name}`);
  }
  return JSON.parse(value) as T;
}

export function intEnv(name: string, fallback?: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing environment variable ${name}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`environment variable ${name} is not a number: ${value}`);
  return n;
}
