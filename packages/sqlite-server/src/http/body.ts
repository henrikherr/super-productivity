import type { IncomingMessage } from 'node:http';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}

export interface BodyLimits {
  /** Max bytes read from the socket (raw, possibly base64 text). */
  maxRawBytes: number;
  /** Max bytes after gzip decompression. */
  maxDecompressedBytes: number;
}

/** Same caps as the reference server (ops 10MB gzip, snapshot 30MB gzip). */
export const OPS_BODY_LIMITS: BodyLimits = {
  maxRawBytes: Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1024,
  maxDecompressedBytes: 30 * 1024 * 1024,
};
export const SNAPSHOT_BODY_LIMITS: BodyLimits = {
  maxRawBytes: Math.ceil((30 * 1024 * 1024 * 4) / 3) + 1024,
  maxDecompressedBytes: 60 * 1024 * 1024,
};
export const DEFAULT_BODY_LIMITS: BodyLimits = {
  maxRawBytes: 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024,
};

const readRaw = (req: IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        reject(new HttpError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });

const normalizeEncoding = (
  value: string | string[] | undefined,
): { value: string; layered: boolean } => {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  const parts = joined
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  return { value: parts[0] ?? '', layered: parts.length > 1 };
};

/**
 * Reads a JSON request body. Supports `Content-Encoding: gzip` and, for native
 * mobile clients, gzip transported as base64 (`Content-Transfer-Encoding: base64`).
 * Returns `undefined` for an empty body.
 */
export const readJsonBody = async (
  req: IncomingMessage,
  limits: BodyLimits,
): Promise<unknown> => {
  const raw = await readRaw(req, limits.maxRawBytes);
  const encoding = normalizeEncoding(req.headers['content-encoding']);
  if (encoding.layered || (encoding.value !== '' && encoding.value !== 'gzip')) {
    throw new HttpError(
      415,
      `Unsupported Content-Encoding: ${encoding.value || 'layered'}`,
    );
  }
  let text: string;
  if (encoding.value === 'gzip') {
    const transfer = normalizeEncoding(req.headers['content-transfer-encoding']).value;
    const compressed =
      transfer === 'base64' ? Buffer.from(raw.toString('ascii'), 'base64') : raw;
    let decompressed: Buffer;
    try {
      decompressed = await gunzipAsync(compressed, {
        maxOutputLength: limits.maxDecompressedBytes,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new HttpError(413, 'Decompressed body too large', 'PAYLOAD_TOO_LARGE');
      }
      throw new HttpError(400, 'Failed to decompress request body');
    }
    text = decompressed.toString('utf8');
  } else {
    if (raw.length > limits.maxDecompressedBytes) {
      throw new HttpError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE');
    }
    text = raw.toString('utf8');
  }
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
};
