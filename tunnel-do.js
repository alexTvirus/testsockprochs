// tunnel-do-simple.js — Durable Object relay đơn giản + HTTP Proxy
// 1 client A (/$web_tunnel) + 1 client B (/$web_client)
// Default: raw binary relay giữa A và B (byte type 0x00)
// Thêm: HTTP request → relay qua A (byte type 0x01 → 0x02)
//
// Giao thức frame mở rộng (binary):
//   [1 byte type] [payload...]
//   TYPE_RAW (0x00): raw data giữa A<->B
//   TYPE_HTTP_REQ (0x01): HTTP request từ DO → A
//   TYPE_HTTP_RES (0x02): HTTP response từ A → DO
// Text frame: giữ nguyên cho PING/PONG/CLIENT_DISCONNECTED

const TYPE_RAW      = 0x00;
const TYPE_HTTP_REQ = 0x01;
const TYPE_HTTP_RES = 0x02;

const TUNNEL_TOKEN = 'abc';
const PING_MS      = 10_000;

const TAG_A = 'side-a';
const TAG_B = 'side-b';

const MSG_PING   = 'PING';
const MSG_PONG   = 'PONG';
const MSG_CLIENT_DISCONNECTED = 'CLIENT_DISCONNECTED';

// ─── Helpers encode/decode HTTP frame ────────────────────────────────────

function encodeHttpRequest(connId, method, path, headers, body) {
  const methodBuf = new TextEncoder().encode(method);
  const pathBuf   = new TextEncoder().encode(path);

  // Tính kích thước header
  let headersSize = 0;
  const encodedHeaders = [];
  for (const [k, v] of headers) {
    const keyBuf = new TextEncoder().encode(k);
    const valBuf = new TextEncoder().encode(v);
    encodedHeaders.push({ keyBuf, valBuf });
    headersSize += 2 + keyBuf.byteLength + 4 + valBuf.byteLength; // keyLen(2)+key + valLen(4)+val
  }

  const totalLen = 4 + 1 + methodBuf.byteLength + 2 + pathBuf.byteLength + 2 + headersSize + 4 + (body ? body.byteLength : 0);
  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);
  let pos = 0;

  view.setUint32(pos, connId, false); pos += 4;
  view.setUint8(pos, methodBuf.byteLength); pos += 1;
  new Uint8Array(buf, pos, methodBuf.byteLength).set(methodBuf); pos += methodBuf.byteLength;
  view.setUint16(pos, pathBuf.byteLength, false); pos += 2;
  new Uint8Array(buf, pos, pathBuf.byteLength).set(pathBuf); pos += pathBuf.byteLength;
  view.setUint16(pos, encodedHeaders.length, false); pos += 2;
  for (const { keyBuf, valBuf } of encodedHeaders) {
    view.setUint16(pos, keyBuf.byteLength, false); pos += 2;
    new Uint8Array(buf, pos, keyBuf.byteLength).set(keyBuf); pos += keyBuf.byteLength;
    view.setUint32(pos, valBuf.byteLength, false); pos += 4;
    new Uint8Array(buf, pos, valBuf.byteLength).set(valBuf); pos += valBuf.byteLength;
  }
  const bodyLen = body ? body.byteLength : 0;
  view.setUint32(pos, bodyLen, false); pos += 4;
  if (body && bodyLen > 0) {
    new Uint8Array(buf, pos, bodyLen).set(new Uint8Array(body));
  }
  return buf;
}

function decodeHttpRequest(buf) {
  const view = new DataView(buf);
  let pos = 0;
  const connId = view.getUint32(pos, false); pos += 4;
  const methodLen = view.getUint8(pos); pos += 1;
  const method = new TextDecoder().decode(buf.slice(pos, pos + methodLen)); pos += methodLen;
  const pathLen = view.getUint16(pos, false); pos += 2;
  const path = new TextDecoder().decode(buf.slice(pos, pos + pathLen)); pos += pathLen;
  const headersCount = view.getUint16(pos, false); pos += 2;
  const headers = [];
  for (let i = 0; i < headersCount; i++) {
    const keyLen = view.getUint16(pos, false); pos += 2;
    const key = new TextDecoder().decode(buf.slice(pos, pos + keyLen)); pos += keyLen;
    const valLen = view.getUint32(pos, false); pos += 4;
    const val = new TextDecoder().decode(buf.slice(pos, pos + valLen)); pos += valLen;
    headers.push([key, val]);
  }
  const bodyLen = view.getUint32(pos, false); pos += 4;
  const body = bodyLen > 0 ? buf.slice(pos, pos + bodyLen) : null;
  return { connId, method, path, headers, body };
}

function encodeHttpResponse(connId, status, headers, body) {
  let headersSize = 0;
  const encodedHeaders = [];
  for (const [k, v] of headers) {
    const keyBuf = new TextEncoder().encode(k);
    const valBuf = new TextEncoder().encode(v);
    encodedHeaders.push({ keyBuf, valBuf });
    headersSize += 2 + keyBuf.byteLength + 4 + valBuf.byteLength;
  }
  const totalLen = 4 + 2 + 2 + headersSize + 4 + (body ? body.byteLength : 0);
  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);
  let pos = 0;
  view.setUint32(pos, connId, false); pos += 4;
  view.setUint16(pos, status, false); pos += 2;
  view.setUint16(pos, encodedHeaders.length, false); pos += 2;
  for (const { keyBuf, valBuf } of encodedHeaders) {
    view.setUint16(pos, keyBuf.byteLength, false); pos += 2;
    new Uint8Array(buf, pos, keyBuf.byteLength).set(keyBuf); pos += keyBuf.byteLength;
    view.setUint32(pos, valBuf.byteLength, false); pos += 4;
    new Uint8Array(buf, pos, valBuf.byteLength).set(valBuf); pos += valBuf.byteLength;
  }
  const bodyLen = body ? body.byteLength : 0;
  view.setUint32(pos, bodyLen, false); pos += 4;
  if (body && bodyLen > 0) {
    new Uint8Array(buf, pos, bodyLen).set(new Uint8Array(body));
  }
  return buf;
}

function decodeHttpResponse(buf) {
  const view = new DataView(buf);
  let pos = 0;
  const connId = view.getUint32(pos, false); pos += 4;
  const status = view.getUint16(pos, false); pos += 2;
  const headersCount = view.getUint16(pos, false); pos += 2;
  const headers = [];
  for (let i = 0; i < headersCount; i++) {
    const keyLen = view.getUint16(pos, false); pos += 2;
    const key = new TextDecoder().decode(buf.slice(pos, pos + keyLen)); pos += keyLen;
    const valLen = view.getUint32(pos, false); pos += 4;
    const val = new TextDecoder().decode(buf.slice(pos, pos + valLen)); pos += valLen;
    headers.push([key, val]);
  }
  const bodyLen = view.getUint32(pos, false); pos += 4;
  const body = bodyLen > 0 ? buf.slice(pos, pos + bodyLen) : null;
  return { connId, status, headers, body };
}

// ─── DO ─────────────────────────────────────────────────────────────────

export class TunnelDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.pendingHttp = new Map(); // connId -> { resolve, reject }
    this.httpConnIdCounter = 0;   // gán connId tăng dần
  }

  _getA() {
    const sockets = this.state.getWebSockets(TAG_A);
    return sockets.length > 0 ? sockets[0] : null;
  }

  _getB() {
    const sockets = this.state.getWebSockets(TAG_B);
    return sockets.length > 0 ? sockets[0] : null;
  }

  _tags(ws) {
    try { return this.state.getTags(ws) ?? []; } catch { return []; }
  }

  // Router chính
  async fetch(request) {
    const url     = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // Reset tiện ích
    if (url.pathname.includes('/reset')) {
      this._closeAll('Reset requested');
      return new Response('ok');
    }

    // WebSocket endpoints
    if (url.pathname === '/$web_tunnel') {
      return this._acceptA(request);
    }
    if (url.pathname === '/$web_client') {
      if (upgrade !== 'websocket') {
        return new Response('WebSocket required', { status: 426 });
      }
      return this._acceptB(request);
    }

    // Nếu không phải WebSocket upgrade -> xử lý như HTTP proxy
    if (upgrade !== 'websocket') {
      return this._handleHttp(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ─── Chấp nhận client A ───────────────────────────────────────────────
  _acceptA(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    const token = request.headers.get('x-tunnel-token')
               || new URL(request.url).searchParams.get('token');
    if (TUNNEL_TOKEN && token !== TUNNEL_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    const oldA = this._getA();
    if (oldA) {
      // Đóng kết nối cũ, pending HTTP sẽ bị reject trong webSocketClose
      try { oldA.close(1000, 'Replaced by new connection'); } catch {}
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [TAG_A]);
    this.state.storage.setAlarm(Date.now() + PING_MS).catch(() => {});

    console.log('[DO] Client A kết nối');
    return new Response(null, { status: 101, webSocket: client });
  }

  _acceptB(request) {
    const oldB = this._getB();
    if (oldB) {
      try { oldB.close(1000, 'Replaced by new connection'); } catch {}
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [TAG_B]);
    console.log('[DO] Client B kết nối');
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Xử lý HTTP request đến (proxy qua tunnel A) ──────────────────────
  async _handleHttp(request) {
    const a = this._getA();
    if (!a) {
      return new Response('Tunnel offline', { status: 502 });
    }

    const connId = ++this.httpConnIdCounter;
    const method = request.method;
    const path   = new URL(request.url).pathname + new URL(request.url).search;
    const headers = [...request.headers.entries()];
    const bodyBuffer = await request.arrayBuffer();

    // Tạo promise chờ response
    const responsePromise = new Promise((resolve, reject) => {
      this.pendingHttp.set(connId, { resolve, reject });
    });

    // Gửi request frame (type 0x01)
    const reqFrame = encodeHttpRequest(connId, method, path, headers, bodyBuffer);
    const typePrefix = new Uint8Array([TYPE_HTTP_REQ]);
    const chunk = new Uint8Array(typePrefix.byteLength + reqFrame.byteLength);
    chunk.set(typePrefix, 0);
    chunk.set(new Uint8Array(reqFrame), typePrefix.byteLength);
    a.send(chunk.buffer);

    // Đợi response với timeout 60s
    const timeout = 60_000;
    let timer;
    try {
      const result = await Promise.race([
        responsePromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timeout')), timeout);
        })
      ]);
      clearTimeout(timer);
      this.pendingHttp.delete(connId);
      const { status, headers, body } = result;
      return new Response(body, { status, headers });
    } catch (err) {
      clearTimeout(timer);
      this.pendingHttp.delete(connId);
      return new Response('Tunnel timeout', { status: 504 });
    }
  }

  // ─── WebSocket handlers ────────────────────────────────────────────────
  webSocketMessage(ws, message) {
        const tags = this._tags(ws);

        if (typeof message === 'string') {
            if (message === MSG_PING) {
                try { ws.send(MSG_PONG); } catch {}
                return;
            }
            return;
        }

        if (tags.includes(TAG_A)) {
            const view = new DataView(message);
            if (message.byteLength < 1) return;
            const type = new Uint8Array(message)[0];
            const payload = message.slice(1);

            if (type === TYPE_RAW) {
                const b = this._getB();
                if (b) {
                    try { b.send(payload); } catch {}
                }
            } else if (type === TYPE_HTTP_RES) {
                console.log(`[DO] Nhận HTTP_RES frame, payloadLen=${payload.byteLength}`);
                try {
                    const { connId, status, headers, body } = decodeHttpResponse(payload);
                    console.log(`[DO] Giải mã HTTP_RES: connId=${connId}, status=${status}`);
                    const pending = this.pendingHttp.get(connId);
                    if (pending) {
                        pending.resolve({ status, headers, body });
                        console.log(`[DO] Đã resolve pending HTTP ${connId}`);
                    } else {
                        console.warn(`[DO] Không tìm thấy pending cho connId=${connId}`);
                    }
                } catch (err) {
                    console.error('[DO] Lỗi decode HTTP response:', err);
                    // Không resolve => DO sẽ timeout, nhưng ta có thể cố gửi lỗi 502 nếu có pending
                    // Đọc connId thô từ payload nếu có thể
                    try {
                        const connId = new DataView(payload).getUint32(0);
                        const pending = this.pendingHttp.get(connId);
                        if (pending) {
                            pending.resolve({ status: 502, headers: [], body: 'Mallformed response' });
                        }
                    } catch {}
                }
            }
            return;
        }

        if (tags.includes(TAG_B)) {
            const a = this._getA();
            if (a) {
                const prefix = new Uint8Array([TYPE_RAW]);
                const combined = new Uint8Array(prefix.byteLength + message.byteLength);
                combined.set(prefix, 0);
                combined.set(new Uint8Array(message), prefix.byteLength);
                try { a.send(combined.buffer); } catch {}
            }
        }
    }

  webSocketClose(ws, code, reason) {
    const tags = this._tags(ws);
    const side = tags.includes(TAG_A) ? 'A' : tags.includes(TAG_B) ? 'B' : '?';
    console.log(`[DO] Client ${side} ngắt kết nối (${code})`);

    if (tags.includes(TAG_A)) {
      this.state.storage.deleteAlarm().catch(() => {});
      // Reject tất cả pending HTTP
      for (const [connId, { reject }] of this.pendingHttp) {
        reject(new Error('Tunnel disconnected'));
      }
      this.pendingHttp.clear();
      const b = this._getB();
      if (b) try { b.close(1001, 'Tunnel disconnected'); } catch {}
      return;
    }
    if (tags.includes(TAG_B)) {
      const a = this._getA();
      if (a) try { a.send(MSG_CLIENT_DISCONNECTED); } catch {}
    }
  }

  webSocketError(ws, error) {
    const tags = this._tags(ws);
    console.error(`[DO] Client ${tags.includes(TAG_A)?'A':tags.includes(TAG_B)?'B':'?'} lỗi:`, error?.message ?? error);
    this.webSocketClose(ws, 1006, 'error');
  }

  async alarm() {
    const a = this._getA();
    if (!a) return;
    try {
      a.send(MSG_PING);
    } catch {
      this.state.storage.deleteAlarm().catch(() => {});
      const b = this._getB();
      if (b) try { b.close(1001, 'Tunnel disconnected'); } catch {}
      return;
    }
    this.state.storage.setAlarm(Date.now() + PING_MS).catch(() => {});
  }

  _closeAll(reason) {
    this.state.storage.deleteAlarm().catch(() => {});
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, reason); } catch {}
    }
  }
}
