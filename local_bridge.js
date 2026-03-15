/**
 * TeleDrive — Local CORS Bridge
 * Run with: node local_bridge.js
 * 
 * Bridges https://teledrive-7cu.pages.dev to http://localhost:8081
 * Handles CORS headers and OPTIONS preflights.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const TARGET_API = 'http://localhost:8081'; // Your local TG Bot API
const PORT = 8082; // Bridge runs on this port
const ALLOWED_ORIGIN = 'https://teledrive-7cu.pages.dev';

const server = http.createServer((req, res) => {
  // 1. Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Id, X-Session-Id, X-Chunk-Index, X-Checksum');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // 2. Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 3. Proxy the request to local Telegram server
  const targetUrl = new URL(req.url, TARGET_API);
  console.log(`Proxying: ${req.method} ${targetUrl.pathname}`);

  const proxyReq = http.request({
    hostname: 'localhost',
    port: 8081,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: 'localhost:8081' }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy Error:', err.message);
    res.writeHead(502);
    res.end('Proxy Error: ' + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`\x1b[32m✔ TeleDrive Local Bridge running at http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[36mℹ Set your Custom TG API URL in Settings to: http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[33m⚠ Note: Some browsers still block HTTPS -> HTTP. You may need to click 'Allow Insecure Content' in your browser settings for this site.\x1b[0m`);
});
