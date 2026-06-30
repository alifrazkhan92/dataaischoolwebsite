/**
 * DAIS portal proxy.
 *
 * Serves the dynamic Django portal (courses listing and the online
 * application form) under www.dataaischool.com so the whole site shares one
 * domain. Each matched path is forwarded, unchanged, to the apply origin.
 * Cloudflare sets the Host header to the origin, so cookies, CSRF and file
 * uploads pass straight through. Same approach as the blog proxy.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = "https://apply.dataaischool.com" + url.pathname + url.search;
    return fetch(new Request(target, request));
  }
};
