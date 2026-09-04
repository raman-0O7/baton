import { createHash } from 'node:crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Serialize a JSON value deterministically.
 *
 * Object keys use JavaScript's UTF-16 code-unit ordering, arrays retain their
 * input order, and strings are emitted without Unicode normalization. Values
 * that JSON would silently coerce or omit are rejected instead.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, new WeakSet<object>(), '$');
}

/** Return a lowercase SHA-256 digest for already encoded bytes or text. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonically serialize a JSON value and return its lowercase SHA-256 digest. */
export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function serializeCanonicalJson(
  value: unknown,
  ancestors: WeakSet<object>,
  path: string,
): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} contains a non-finite number`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`${path} contains a non-JSON ${typeof value} value`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] is a sparse array element`);
        }
        items.push(
          serializeCanonicalJson(value[index], ancestors, `${path}[${index}]`),
        );
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} contains a non-plain object`);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new TypeError(`${path} contains a symbol property`);
    }

    const record = value as Record<string, unknown>;
    return `{${(ownKeys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
          throw new TypeError(`${path}.${key} is an accessor property`);
        }
        return `${JSON.stringify(key)}:${serializeCanonicalJson(
          record[key],
          ancestors,
          `${path}.${key}`,
        )}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
