/**
 * Minimal RFC 6455 WebSocket endpoint for `/api/sync/ws` (no dependency).
 * Message contract mirrors super-sync-server websocket-connection.service.ts:
 * server → client: `connected`, `new_ops {latestSeq}`, `ping`, `presence_state`,
 * `presence_cmd`; client → server: `pong`, `presence_state`, `presence_cmd`.
 * Presence payloads are opaque (encrypted by the client) and never persisted.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { authenticateToken } from '../auth/tokens';
import type { App } from '../app';
import { touchDevice } from '../sync/upload';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLIENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,255}$/;
const MAX_FRAME_BYTES = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = PING_INTERVAL_MS + 10_000;
const MAX_CONNECTIONS_PER_USER = 10;
const RECONNECT_COOLDOWN_MS = 5_000;
const MAX_PRESENCE_PAYLOAD_BYTES = 8_192;
const PRESENCE_RATE_WINDOW_MS = 10_000;
const PRESENCE_RATE_MAX_PER_WINDOW = 15;
const PRESENCE_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

export const WS_CLOSE = {
  AUTH_FAILED: 4003,
  TOO_MANY: 4008,
  REPLACED: 4009,
} as const;

class WsConnection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  open = true;
  lastSeen = Date.now();
  readonly connectedAt = Date.now();
  presenceWindowStart = Date.now();
  presenceCount = 0;
  onText?: (text: string) => void;
  onClose?: () => void;

  constructor(
    private readonly socket: Duplex,
    readonly userId: number,
    readonly clientId: string,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.handleClosed());
    socket.on('error', () => this.handleClosed());
  }

  private handleClosed(): void {
    if (!this.open) return;
    this.open = false;
    this.onClose?.();
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.open) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendJson(message: Record<string, unknown>): boolean {
    if (!this.open) return false;
    try {
      this.writeFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'));
      return true;
    } catch {
      return false;
    }
  }

  ping(): void {
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  close(code: number, reason: string): void {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.writeFrame(0x8, body);
    } finally {
      this.open = false;
      this.socket.end();
      setTimeout(() => this.socket.destroy(), 1000).unref();
      this.onClose?.();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.open) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          this.close(1009, 'Message too big');
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (!masked) {
        // RFC 6455 §5.1: client frames MUST be masked.
        this.close(1002, 'Unmasked frame');
        return;
      }
      if (len > MAX_FRAME_BYTES) {
        this.close(1009, 'Message too big');
        return;
      }
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      this.lastSeen = Date.now();

      if (opcode === 0x8) {
        this.close(1000, '');
        return;
      }
      if (opcode === 0x9) {
        this.writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, f) => n + f.length, 0);
        if (total > MAX_FRAME_BYTES) {
          this.close(1009, 'Message too big');
          return;
        }
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onText?.(text);
        }
        continue;
      }
      // Binary or unknown opcodes are not part of the protocol.
      this.close(1003, 'Unsupported data');
      return;
    }
  }
}

interface PresenceState {
  payload: string;
  ordinal: number;
  producerClientId: string;
  updatedAt: number;
  producerConnected: boolean;
}

export class SyncWebSocketHub {
  private readonly connections = new Map<number, Set<WsConnection>>();
  private readonly presence = new Map<number, PresenceState>();
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly app: App) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    this.heartbeat = setInterval(() => this.tick(), PING_INTERVAL_MS);
    this.heartbeat.unref();
    server.on('close', () => this.shutdown());
  }

  shutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.connections.values()) {
      for (const c of set) c.close(1001, 'Server shutting down');
    }
    this.connections.clear();
  }

  connectionCount(userId: number): number {
    return this.connections.get(userId)?.size ?? 0;
  }

  notifyNewOps(userId: number, originClientId: string | null, latestSeq: number): void {
    const set = this.connections.get(userId);
    if (!set) return;
    for (const c of set) {
      if (c.clientId !== originClientId) {
        c.sendJson({ type: 'new_ops', latestSeq, timestamp: Date.now() });
      }
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (
      url.pathname !== '/api/sync/ws' ||
      typeof key !== 'string' ||
      (req.headers.upgrade ?? '').toLowerCase() !== 'websocket'
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const token = url.searchParams.get('token') ?? undefined;
    const clientId = url.searchParams.get('clientId') ?? '';
    const auth = authenticateToken(this.app.db, token);
    const conn = new WsConnection(socket, auth?.userId ?? -1, clientId);
    if (!token || !CLIENT_ID_REGEX.test(clientId)) {
      conn.close(4001, 'Invalid request');
      return;
    }
    if (!auth || auth.scope !== 'sync') {
      conn.close(WS_CLOSE.AUTH_FAILED, 'Invalid token');
      return;
    }
    this.addConnection(conn);
  }

  private addConnection(conn: WsConnection): void {
    const { userId, clientId } = conn;
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    for (const existing of set) {
      if (existing.clientId !== clientId) continue;
      if (existing.open && Date.now() - existing.connectedAt < RECONNECT_COOLDOWN_MS) {
        conn.close(WS_CLOSE.TOO_MANY, 'Reconnecting too fast');
        return;
      }
      set.delete(existing);
      existing.close(WS_CLOSE.REPLACED, 'Replaced by newer connection');
    }
    if (set.size >= MAX_CONNECTIONS_PER_USER) {
      conn.close(WS_CLOSE.TOO_MANY, 'Too many connections');
      return;
    }
    set.add(conn);
    conn.onText = (text) => this.onMessage(conn, text);
    conn.onClose = () => this.removeConnection(conn);

    const presence = this.presence.get(userId);
    if (
      presence &&
      presence.producerClientId === clientId &&
      !presence.producerConnected
    ) {
      presence.producerConnected = true;
      this.relay(userId, clientId, this.presenceStateMsg(presence));
    }
    conn.sendJson({ type: 'connected', userId, timestamp: Date.now() });
    if (
      presence &&
      presence.producerClientId !== clientId &&
      Date.now() - presence.updatedAt < PRESENCE_SNAPSHOT_MAX_AGE_MS
    ) {
      conn.sendJson(this.presenceStateMsg(presence));
    }
  }

  private removeConnection(conn: WsConnection): void {
    const set = this.connections.get(conn.userId);
    if (!set?.delete(conn)) return;
    if (set.size === 0) this.connections.delete(conn.userId);
    const presence = this.presence.get(conn.userId);
    const producerStillConnected = [...(set ?? [])].some(
      (c) => c.clientId === conn.clientId,
    );
    if (
      presence &&
      presence.producerClientId === conn.clientId &&
      !producerStillConnected
    ) {
      presence.producerConnected = false;
      this.relay(conn.userId, conn.clientId, this.presenceStateMsg(presence));
    }
  }

  private onMessage(conn: WsConnection, text: string): void {
    let msg: { type?: unknown; payload?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type !== 'presence_state' && msg.type !== 'presence_cmd') return;
    const payload = msg.payload;
    if (typeof payload !== 'string' || payload.length === 0) return;
    if (Buffer.byteLength(payload, 'utf8') > MAX_PRESENCE_PAYLOAD_BYTES) return;
    const now = Date.now();
    if (now - conn.presenceWindowStart > PRESENCE_RATE_WINDOW_MS) {
      conn.presenceWindowStart = now;
      conn.presenceCount = 0;
    }
    if (++conn.presenceCount > PRESENCE_RATE_MAX_PER_WINDOW) return;

    if (msg.type === 'presence_state') {
      const prev = this.presence.get(conn.userId);
      const next: PresenceState = {
        payload,
        ordinal: (prev?.ordinal ?? 0) + 1,
        producerClientId: conn.clientId,
        updatedAt: now,
        producerConnected: true,
      };
      this.presence.set(conn.userId, next);
      this.relay(conn.userId, conn.clientId, this.presenceStateMsg(next));
    } else {
      this.relay(conn.userId, conn.clientId, {
        type: 'presence_cmd',
        payload,
        timestamp: now,
      });
    }
  }

  private presenceStateMsg(p: PresenceState): Record<string, unknown> {
    return {
      type: 'presence_state',
      payload: p.payload,
      ordinal: p.ordinal,
      producerConnected: p.producerConnected,
      timestamp: p.updatedAt,
    };
  }

  private relay(
    userId: number,
    excludeClientId: string,
    message: Record<string, unknown>,
  ): void {
    for (const c of this.connections.get(userId) ?? []) {
      if (c.clientId !== excludeClientId) c.sendJson(message);
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const [userId, set] of this.connections) {
      for (const c of [...set]) {
        if (now - c.lastSeen > PONG_TIMEOUT_MS + PING_INTERVAL_MS) {
          c.close(1001, 'Heartbeat timeout');
          continue;
        }
        touchDevice(this.app.db, userId, c.clientId, undefined, now);
        c.sendJson({ type: 'ping', timestamp: now });
        c.ping();
      }
    }
  }
}
