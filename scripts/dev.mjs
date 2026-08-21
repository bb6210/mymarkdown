import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const server = await createServer({
  server: { port: 5173, strictPort: true },
});
await server.listen();

const devUrl = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173';
process.env.VITE_DEV_SERVER_URL = devUrl;

console.log(`[dev] Vite 开发服务器: ${devUrl}`);
console.log('[dev] 启动 Electron…');

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: process.env });

function shutdown(code = 0) {
  server.close();
  process.exit(code);
}

child.on('close', (code) => shutdown(code ?? 0));
child.on('error', (err) => {
  console.error('[dev] Electron 启动失败:', err);
  shutdown(1);
});

process.on('SIGINT', () => {
  child.kill();
  shutdown(0);
});