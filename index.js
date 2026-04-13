// src/index.js — Worker entry point
// Route mọi request đến Durable Object theo hostname

export { TunnelDO } from './tunnel-do.js';

export default {
  async fetch(request, env) {
    const host = request.headers.get('host') || new URL(request.url).hostname;
    const id   = env.TUNNEL.idFromName(host);
    const stub = env.TUNNEL.get(id);
    return stub.fetch(request);
  },
};
