// Simple static file server for OpenNext assets
// This provides an ASSETS-like binding for workerd that reads from the filesystem

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;

    // Default to index.html for root
    if (path === '/' || path === '') {
      path = '/index.html';
    }
    const assetService = env.ASSETS_DISK;
    if (!assetService?.fetch) {
      return new Response('Asset service unavailable', { status: 500 });
    }

    const assetUrl = new URL(path, 'https://assets.local');
    const response = await assetService.fetch(assetUrl, {
      method: request.method,
      headers: request.headers,
    });

    if (!response.ok) {
      console.error(`[assets-service] ${response.status} ${path}`);
      return response;
    }

    const headers = new Headers(response.headers);
    const contentType = getContentType(path);
    if (contentType) {
      headers.set('Content-Type', contentType);
    }
    headers.set(
      'Cache-Control',
      path.includes('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    );

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};

function getContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const types = {
    'html': 'text/html; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'mjs': 'application/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'webp': 'image/webp',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
    'txt': 'text/plain; charset=utf-8',
    'xml': 'application/xml',
    'webmanifest': 'application/manifest+json',
    'map': 'application/json',
  };
  return types[ext] || 'application/octet-stream';
}
