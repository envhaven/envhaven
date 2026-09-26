export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

export function rowIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < -1) {
    throw new Error(`${label} must be -1 or a non-negative integer`);
  }
  return value as number;
}

export function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

export function exact(actual: readonly string[], expected: readonly string[], label: string): void {
  const got = [...actual].sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((value, index) => value !== want[index])) {
    throw new Error(`${label} must be exactly ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}
