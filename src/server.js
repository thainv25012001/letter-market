import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './room-manager.js';

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDirectory, `.${requestedPath}`);
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

const webSocketServer = new WebSocketServer({ server, path: '/ws' });
const roomManager = new RoomManager();
webSocketServer.on('connection', (socket) => roomManager.attach(socket));

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function listen(port) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && !process.env.PORT && port === 3000) {
      console.log('Port 3000 is busy; selecting an available local port.');
      listen(0);
      return;
    }
    console.error(`Unable to start the game server: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    console.log(`Letter Market is ready at http://localhost:${activePort}`);
    for (const host of localAddresses()) {
      console.log(`Same-network devices can use http://${host}:${activePort}`);
    }
    console.log('Press Ctrl+C to stop the server.');
  });
}

listen(Number.parseInt(process.env.PORT ?? '3000', 10));

process.on('SIGINT', () => {
  webSocketServer.close();
  server.close(() => process.exit(0));
});
