/**
 * DAIS portal proxy.
 *
 * Serves the dynamic Django portal under www.dataaischool.com so the whole site
 * shares one domain. Each matched path is forwarded to the apply origin.
 * Cookies, CSRF and file uploads pass straight through.
 *
 * The subrequest to the origin would otherwise lose the real client IP (the
 * origin only sees Cloudflare/worker IPs), which breaks per-IP rate limiting. So
 * we forward the genuine client IP (CF-Connecting-IP) as X-Real-Client-IP and
 * sign it with the shared secret X-Proxy-Auth (a Wrangler secret), which the
 * origin verifies. Both headers are overwritten here, so a client cannot forge
 * them through this worker.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = "https://apply.dataaischool.com" + url.pathname + url.search;
    const req = new Request(target, request);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) req.headers.set("X-Real-Client-IP", ip);
    if (env && env.PROXY_SHARED_SECRET) req.headers.set("X-Proxy-Auth", env.PROXY_SHARED_SECRET);
    return fetch(req);
  }
};
