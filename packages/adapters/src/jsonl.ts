/** Return complete JSONL records; an unterminated final record is not observed. */
export function completeJsonLines(content: string): string[] {
  const completeLength = content.lastIndexOf('\n') + 1;
  if (completeLength === 0) return [];
  return content.slice(0, completeLength).split('\n').slice(0, -1);
}

export function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (line.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  return typeof candidate === 'string' ? candidate : undefined;
}
