/**
 * lite-http-tunnel — Cloudflare Workers + Durable Objects edition
 *
 * Không dùng biến toàn cục. State (tunnelSocket, pendingRequests) sống
 * hoàn toàn bên trong Durable Object "TunnelHub".
 *
 * wrangler.toml cần có:
 * ─────────────────────────────────────────
 * name = "lite-http-tunnel"
 * main = "worker.js"
 * compatibility_date = "2024-01-01"
 *
 * [[durable_objects.bindings]]
 * name = "TUNNEL_HUB"
 * class_name = "TunnelHub"
 *
 * [[migrations]]
 * tag = "v1"
 * new_classes = ["TunnelHub"]
 * ─────────────────────────────────────────
 *
 * Endpoints:
 *   GET /$web_tunnel   — tunnel client kết nối WebSocket vào đây
 *   *   /*             — mọi request khác được proxy qua tunnel
 */

const WEB_TUNNEL_PATH = '/$web_tunnel';
const REQUEST_TIMEOUT_MS = 30_000;
const SECRET_KEY = "abc"
const VERIFY_TOKEN = "abc"
const JWT_GENERATOR_USERNAME = "abc"
const JWT_GENERATOR_PASSWORD = "abc"

// ─── Worker entry point ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // JWT generator (tuỳ chọn)
    if (url.pathname === '/tunnel_jwt_generator') {
      return handleJwtGenerator(url, env);
    }

    // Tất cả request đều đi qua cùng một Durable Object instance ("singleton")
    const id = env.TUNNEL_HUB.idFromName('singleton');
    const hub = env.TUNNEL_HUB.get(id);
    return hub.fetch(request);
  },
};

// ─── Durable Object ───────────────────────────────────────────────────────────
export class TunnelHub {
  constructor(state, env) {
    this.state = state;
    this.env   = env;

    // State thực sự — không global, sống trong instance này
    this.tunnelSocket    = null;      // WebSocket tới tunnel client
    this.pendingRequests = new Map(); // requestId → { resolve, reject, timer }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === WEB_TUNNEL_PATH) {
      return this._handleTunnelUpgrade(request);
    }

    return this._handleProxyRequest(request);
  }

  // ── Tunnel WebSocket upgrade ────────────────────────────────────────────────
  _handleTunnelUpgrade(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Đóng kết nối cũ nếu còn tồn tại
    this._closeTunnel('Replaced by new connection');

    const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
    serverSocket.accept();
    this.tunnelSocket = serverSocket;

    console.log('[TunnelHub] tunnel client connected');

    serverSocket.addEventListener('message', (ev) => {
      this._onTunnelMessage(ev.data);
    });

    serverSocket.addEventListener('close', (ev) => {
      console.log('[TunnelHub] tunnel disconnected:', ev.code, ev.reason);
      this.tunnelSocket = null;
      this._rejectAllPending('Tunnel disconnected');
    });

    serverSocket.addEventListener('error', () => {
      console.error('[TunnelHub] tunnel socket error');
    });

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  // ── Proxy HTTP request qua tunnel ──────────────────────────────────────────
  async _handleProxyRequest(request) {
    if (!this._isTunnelOpen()) {
      return new Response('Tunnel not connected', { status: 502 });
    }

    const requestId = generateId();

    // Đọc body
    let bodyData = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 0) bodyData = arrayBufferToBase64(buf);
    }

    // Gửi request tới tunnel client
    const msg = JSON.stringify({
      type: 'request',
      requestId,
      data: {
        method:  request.method,
        headers: headersToObject(request.headers),
        path:    new URL(request.url).pathname + new URL(request.url).search,
        body:    bodyData,
      },
    });

    try {
      this.tunnelSocket.send(msg);
    } catch {
      return new Response('Failed to forward request to tunnel', { status: 502 });
    }

    // Chờ response
    try {
      const res = await this._waitForResponse(requestId);
      const body = res.body ? base64ToUint8Array(res.body) : null;
      return new Response(body, {
        status:     res.statusCode,
        statusText: res.statusMessage || '',
        headers:    res.headers || {},
      });
    } catch (err) {
      return new Response(`Tunnel error: ${err.message}`, { status: 502 });
    }
  }

  // ── Xử lý message từ tunnel client ────────────────────────────────────────
  _onTunnelMessage(raw) {
    // Ping dạng plain text
    if (raw === 'ping') {
      try { this.tunnelSocket.send('pong'); } catch {}
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    switch (msg.type) {
      case 'response': {
        const p = this.pendingRequests.get(msg.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pendingRequests.delete(msg.requestId);
          p.resolve(msg.data);
        }
        break;
      }
      case 'request-error': {
        const p = this.pendingRequests.get(msg.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pendingRequests.delete(msg.requestId);
          p.reject(new Error(msg.error || 'Request error'));
        }
        break;
      }
      case 'ping':
        try { this.tunnelSocket.send(JSON.stringify({ type: 'pong' })); } catch {}
        break;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  _waitForResponse(requestId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });
  }

  _isTunnelOpen() {
    return this.tunnelSocket !== null && this.tunnelSocket.readyState === 1;
  }

  _closeTunnel(reason = 'Closed') {
    if (this.tunnelSocket) {
      try { this.tunnelSocket.close(1000, reason); } catch {}
      this.tunnelSocket = null;
    }
    this._rejectAllPending(reason);
  }

  _rejectAllPending(reason) {
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}

// ─── JWT generator (chạy ở Worker layer, không cần DO) ────────────────────────
async function handleJwtGenerator(url, env) {
  const username    = env.JWT_GENERATOR_USERNAME;
  const password    = env.JWT_GENERATOR_PASSWORD;
  const secretKey   = env.SECRET_KEY;
  const verifyToken = env.VERIFY_TOKEN;

  if (!username || !password) return new Response('Not found', { status: 404 });

  if (url.searchParams.get('username') !== username ||
      url.searchParams.get('password') !== password) {
    return new Response('Forbidden', { status: 401 });
  }

  const token = await signJwt({ token: verifyToken }, secretKey);
  return new Response(token, { status: 200 });
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function headersToObject(headers) {
  const obj = {};
  for (const [k, v] of headers.entries()) obj[k] = v;
  return obj;
}

function arrayBufferToBase64(buffer) {
  let bin = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function generateId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

// ── Minimal JWT HS256 (không dùng thư viện ngoài) ─────────────────────────────
async function signJwt(payload, secret) {
  const enc = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, iat: Math.floor(Date.now() / 1000) })}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sigB64}`;
}

async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sig = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, sig,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error('Invalid signature');
  return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
}
