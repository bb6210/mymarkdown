import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, shell } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import type {
  CommunityAuth,
  CommunityLoginResult,
  CommunityPublishPayload,
  CommunityPublishResult,
  ExportResult,
  FileEntry,
  ThemeExportPayload,
  ThemeImportResult,
} from '../shared/api';

const APP_SCHEME = 'app';

// 必须在使用 app 之前注册自定义协议（standard + secure，使 app:// 具备与 http 一致的来源语义）
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow: BrowserWindow | null = null;
let pendingOpenPath: string | null = null;

const MARKDOWN_EXT = /\.(md|markdown|txt)$/i;

// 递归判断目录（或其子目录）是否包含 Markdown/TXT 文件，用于过滤无关文件夹
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 800;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.svn', '.hg']);

async function containsMarkdownFile(dir: string, depth: number, budget: { left: number }): Promise<boolean> {
  if (depth > MAX_SCAN_DEPTH || budget.left <= 0) return false;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of dirents) {
    if (budget.left <= 0) return false;
    budget.left--;
    if (d.isDirectory()) {
      if (SKIP_DIR_NAMES.has(d.name) || d.name.startsWith('.')) continue;
      if (await containsMarkdownFile(path.join(dir, d.name), depth + 1, budget)) return true;
    } else if (d.isFile() && MARKDOWN_EXT.test(d.name)) {
      return true;
    }
  }
  return false;
}

// 文件内容缓存（LRU + mtime 校验），减少反复打开时的磁盘读取/杀毒扫描开销
const MAX_FILE_CACHE = 40;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const fileCache = new Map<string, { mtimeMs: number; size: number; content: string }>();

function cacheFileContent(filePath: string, content: string, stat: { mtimeMs: number; size: number }): void {
  if (stat.size > MAX_CACHE_BYTES) return;
  if (fileCache.size >= MAX_FILE_CACHE) {
    const first = fileCache.keys().next().value;
    if (first !== undefined) fileCache.delete(first);
  }
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
}

function sendMenuAction(action: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu', action);
  }
}
function findFileFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    if (MARKDOWN_EXT.test(arg) && existsSync(arg)) return arg;
  }
  return null;
}

function queueOpenFile(filePath: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-file', filePath);
  } else {
    pendingOpenPath = filePath;
  }
}

function communityAuthPath(): string {
  return path.join(app.getPath('userData'), 'community-auth.json');
}

function normalizeCommunityBaseUrl(raw: string): string {
  let url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url;
}

async function loginToCommunity(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    const res = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json().catch(() => ({}))) as { token?: unknown; error?: unknown };
    if (!res.ok) {
      return { ok: false, error: typeof data.error === 'string' ? data.error : '登录失败：' + res.status };
    }
    if (typeof data.token !== 'string' || !data.token) {
      return { ok: false, error: '登录失败：服务器未返回 token' };
    }
    return { ok: true, token: data.token };
  } catch (error) {
    console.error('[community] login', error);
    return { ok: false, error: '无法连接社区服务器：' + (error instanceof Error ? error.message : String(error)) };
  }
}

async function saveCommunityAuthFile(auth: CommunityAuth): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(communityAuthPath()), { recursive: true });
    await fs.writeFile(communityAuthPath(), JSON.stringify(auth, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('[community] saveAuth', error);
    return false;
  }
}


function sanitizeFileName(raw: string): string | null {
  let name = raw.trim();
  if (!name || name === '.' || name === '..') return null;
  if (/[\\/:*?"<>|]/.test(name)) return null;
  if (!MARKDOWN_EXT.test(name)) name += '.md';
  return name;
}

function sanitizeDirName(raw: string): string | null {   const name = raw.trim();   if (!name || name === '.' || name === '..') return null;   if (/[\\/:*?"<>|]/.test(name)) return null;   return name; }

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.pjpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.dib': 'image/bmp',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.heics': 'image/heic-sequence',
  '.heifs': 'image/heif-sequence',
  '.jxl': 'image/jxl',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const FS_PREFIX = '/fs/';
    if (pathname.startsWith(FS_PREFIX)) {
      const filePath = pathname.slice(FS_PREFIX.length);
      try {
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME_TYPES[ext] ?? 'application/octet-stream';
        return new Response(data, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
      } catch (error) {
        console.error('[app-protocol:fs] read failed:', filePath, error);
        return new Response('Not Found', { status: 404 });
      }
    }
    const distDir = path.join(__dirname, '../../dist');
    const resolved = path.normalize(path.join(distDir, pathname));
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const type = MIME_TYPES[ext] ?? 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': type } });
    } catch (error) {
      console.error('[app-protocol] 读取失败:', resolved, error);
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    title: 'MyMarkdown',
    backgroundColor: '#f7f8fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  win.webContents.once('did-finish-load', () => {
    const filePath = pendingOpenPath ?? findFileFromArgv(process.argv);
    pendingOpenPath = null;
    if (filePath) win.webContents.send('open-file', filePath);
  });

  // 渲染进程诊断：加载失败 / 崩溃 / 控制台错误都会打到主进程终端
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[did-fail-load] code=${errorCode} desc=${errorDescription} url=${validatedURL} main=${isMainFrame}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', details);
  });
  win.webContents.on('console-message', (details) => {
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL(`${APP_SCHEME}://bundle/index.html`);
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建文件', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('open-folder') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save') },
        { type: 'separator' },
        { label: '导出 Markdown…', click: () => sendMenuAction('export-md') },
        { label: '导出 HTML…', click: () => sendMenuAction('export-html') },
        { label: '导出 PDF…', click: () => sendMenuAction('export-pdf') },
        { type: 'separator' },
        { label: '导入样式文件…', click: () => sendMenuAction('import-theme') },
        { label: '导出样式文件…', click: () => sendMenuAction('export-theme') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenuAction('toggle-theme') },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle('dialog:openFolder', async (): Promise<string | null> => {
    const win = mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Markdown 文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fs:readDir', async (_event, dir: string): Promise<FileEntry[]> => {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (d.isDirectory()) {
        // 只显示（直接或子目录）包含 Markdown/TXT 文件的文件夹，避免无关文件夹
        if (SKIP_DIR_NAMES.has(d.name) || d.name.startsWith('.')) continue;
        if (await containsMarkdownFile(path.join(dir, d.name), 0, { left: MAX_SCAN_ENTRIES })) {
          entries.push({ name: d.name, path: path.join(dir, d.name), isDir: true });
        }
      } else if (d.isFile()) {
        if (MARKDOWN_EXT.test(d.name)) {
          entries.push({ name: d.name, path: path.join(dir, d.name), isDir: false });
        }
      }
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    return entries;
  });

  ipcMain.handle('fs:readFile', async (_event, filePath: string): Promise<string> => {
    try {
      const stat = await fs.stat(filePath);
      const cached = fileCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.content;
      }
      const content = await fs.readFile(filePath, 'utf-8');
      cacheFileContent(filePath, content, stat);
      return content;
    } catch {
      return await fs.readFile(filePath, 'utf-8');
    }
  });

  ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string): Promise<boolean> => {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      fileCache.delete(filePath);
      return true;
    } catch (error) {
      console.error('[fs:writeFile]', error);
      return false;
    }
  });

  async function uniqueFileTarget(dir: string, name: string): Promise<string | null> {
    const ext = path.extname(name);
    const base = ext ? name.slice(0, name.length - ext.length) : name;
    for (let i = 0; i < 10000; i++) {
      const candidate = i === 0 ? base + ext : base + ' (' + i + ')' + ext;
      const full = path.join(dir, candidate);
      try {
        await fs.access(full);
      } catch {
        return full;
      }
    }
    return null;
  }

  ipcMain.handle(
    'fs:saveImage',
    async (
      _event,
      payload: { data: ArrayBuffer | Uint8Array; dir: string; name?: string; ext?: string },
    ): Promise<string | null> => {
      try {
        const buf = Buffer.from(payload.data as Uint8Array);
        if (buf.byteLength === 0) return null;
        let ext = (payload.ext ?? '').trim().toLowerCase();
        if (ext && !ext.startsWith('.')) ext = '.' + ext;
        if (!/^\.[a-z0-9]{1,10}$/.test(ext)) ext = '.png';
        let base = (payload.name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        if (!base) {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, '0');
          base =
            '图片 ' +
            d.getFullYear() +
            '-' +
            pad(d.getMonth() + 1) +
            '-' +
            pad(d.getDate()) +
            '-' +
            pad(d.getHours()) +
            pad(d.getMinutes()) +
            pad(d.getSeconds());
        }
        base = base.replace(/\.[a-z0-9]{1,10}$/i, '');
        await fs.mkdir(payload.dir, { recursive: true });
        const target = await uniqueFileTarget(payload.dir, base + ext);
        if (!target) return null;
        await fs.writeFile(target, buf);
        return target;
      } catch (error) {
        console.error('[fs:saveImage]', error);
        return null;
      }
    },
  );

  ipcMain.handle('fs:readImageDataUrl', async (_event, filePath: string): Promise<string | null> => {
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext];
      if (!mime || !mime.startsWith('image/')) return null;
      return 'data:' + mime.split(';')[0] + ';base64,' + data.toString('base64');
    } catch (error) {
      console.error('[fs:readImageDataUrl]', error);
      return null;
    }
  });

  ipcMain.handle('dialog:openImage', async (): Promise<string | null> => {
    const win = mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片',
      properties: ['openFile'],
      filters: [
        {
          name: '图片',
          extensions: [
            'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjpg', 'gif', 'webp', 'avif', 'apng',
            'bmp', 'dib', 'svg', 'svgz', 'ico', 'cur', 'tif', 'tiff', 'heic', 'heif', 'heics', 'heifs',
            'jxl', 'psd', 'xcf', 'exr', 'hdr', 'pcx', 'tga', 'dds', 'pnm', 'pgm', 'ppm', 'pbm', 'pam',
            'qoi', 'wbmp', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'rw2', 'orf', 'pef', 'srw', 'raf',
          ],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    'fs:readImageFile',
    async (_event, filePath: string): Promise<{ name: string; type: string; data: Uint8Array } | null> => {
      try {
        const data = await fs.readFile(filePath);
        if (data.byteLength === 0) return null;
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext];
        if (!mime || !mime.startsWith('image/')) return null;
        return { name: path.basename(filePath), type: mime.split(';')[0], data: new Uint8Array(data) };
      } catch (error) {
        console.error('[fs:readImageFile]', error);
        return null;
      }
    },
  );

  ipcMain.handle('clipboard:copyImage', async (_event, filePath: string): Promise<boolean> => {
    try {
      const image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) return false;
      clipboard.writeImage(image);
      return true;
    } catch (error) {
      console.error('[clipboard:copyImage]', error);
      return false;
    }
  });

  ipcMain.handle('shell:openImage', async (_event, filePath: string): Promise<void> => {
    try {
      await shell.openPath(filePath);
    } catch (error) {
      console.error('[shell:openImage]', error);
    }
  });

  ipcMain.handle('fs:writeImageFile', async (_event, filePath: string, data: Uint8Array): Promise<boolean> => {
    try {
      await fs.writeFile(filePath, Buffer.from(data as Uint8Array));
      return true;
    } catch (error) {
      console.error('[fs:writeImageFile]', error);
      return false;
    }
  });

  ipcMain.handle('fs:createFile', async (_event, dir: string, name: string): Promise<string | null> => {
    const safe = sanitizeFileName(name);
    if (!safe) return null;
    const filePath = path.join(dir, safe);
    try {
      await fs.access(filePath);
      return null;
    } catch {
      // 文件不存在，继续创建
    }
    try {
      await fs.writeFile(filePath, '', 'utf-8');
      return filePath;
    } catch (error) {
      console.error('[fs:createFile]', error);
      return null;
    }
  });

  ipcMain.handle('fs:createDir', async (_event, dir: string, name: string): Promise<string | null> => {
    const safe = sanitizeDirName(name);
    if (!safe) return null;
    const target = path.join(dir, safe);
    try {
      await fs.access(target);
      return null;
    } catch {
      // 目录不存在，继续创建
    }
    try {
      await fs.mkdir(target);
      return target;
    } catch (error) {
      console.error('[fs:createDir]', error);
      return null;
    }
  });

  ipcMain.handle('fs:copyEntry', async (_event, srcPath: string, destDir: string): Promise<string | null> => {
    const name = path.basename(srcPath);
    const ext = path.extname(name);
    const base = ext ? name.slice(0, name.length - ext.length) : name;
    for (let i = 0; i < 1000; i++) {
      const targetName = i === 0 ? `${base} (副本)${ext}` : `${base} (副本 ${i})${ext}`;
      const target = path.join(destDir, targetName);
      try {
        await fs.cp(srcPath, target, { recursive: true, errorOnExist: true });
        return target;
      } catch {
        // 目标已存在，尝试下一个编号
      }
    }
    return null;
  });

  ipcMain.handle('fs:renameFile', async (_event, oldPath: string, newName: string): Promise<string | null> => {
    const safe = sanitizeFileName(newName);
    if (!safe) return null;
    const target = path.join(path.dirname(oldPath), safe);
    if (target === oldPath) return oldPath;
    try {
      await fs.rename(oldPath, target);
      fileCache.delete(oldPath);
      fileCache.delete(target);
      return target;
    } catch (error) {
      console.error('[fs:renameFile]', error);
      return null;
    }
  });

  ipcMain.handle('fs:deleteFile', async (_event, filePath: string): Promise<boolean> => {
    try {
      await fs.unlink(filePath);
      fileCache.delete(filePath);
      return true;
    } catch (error) {
      console.error('[fs:deleteFile]', error);
      return false;
    }
  });

  ipcMain.handle(
    'export:markdown',
    async (_event, payload: { defaultName: string; content: string }): Promise<ExportResult> => {
      const win = mainWindow;
      if (!win) return { canceled: true, filePath: null };
      const result = await dialog.showSaveDialog(win, {
        title: '导出 Markdown',
        defaultPath: payload.defaultName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true, filePath: null };
      await fs.writeFile(result.filePath, payload.content, 'utf-8');
      return { canceled: false, filePath: result.filePath };
    },
  );

  ipcMain.handle(
    'export:html',
    async (
      _event,
      payload: { defaultName: string; html: string; baseDir?: string | null },
    ): Promise<ExportResult> => {
      const win = mainWindow;
      if (!win) return { canceled: true, filePath: null };
      const result = await dialog.showSaveDialog(win, {
        title: '导出 HTML',
        defaultPath: payload.defaultName,
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true, filePath: null };
      try {
        let outHtml = payload.html;
        if (payload.baseDir) {
          outHtml = await copyImagesForExport(payload.html, payload.baseDir, result.filePath);
        }
        await fs.writeFile(result.filePath, outHtml, 'utf-8');
        return { canceled: false, filePath: result.filePath };
      } catch (error) {
        console.error('[export:html]', error);
        return { canceled: true, filePath: null };
      }
    },
  );

  function isRelativeImageSrc(src: string): boolean {
    return !/^(data:|https?:|file:|app:|blob:|\/|[A-Za-z]:[\\/])/i.test(src);
  }

  async function uniqueExportName(name: string, dir: string): Promise<string> {
    const ext = path.extname(name);
    const base = ext ? name.slice(0, name.length - ext.length) : name;
    for (let i = 0; i < 10000; i++) {
      const candidate = i === 0 ? base + ext : base + ' (' + i + ')' + ext;
      try {
        await fs.access(path.join(dir, candidate));
      } catch {
        return candidate;
      }
    }
    return base + '-' + Date.now() + ext;
  }

  async function copyImagesForExport(html: string, baseDir: string, targetHtmlPath: string): Promise<string> {
    const targetDir = path.join(path.dirname(targetHtmlPath), 'assets');
    await fs.mkdir(targetDir, { recursive: true });
    const srcs = Array.from(html.matchAll(/src="([^"]+)"/g), (m) => m[1]);
    const replaced = new Map<string, string>();
    for (const src of srcs) {
      if (replaced.has(src) || !isRelativeImageSrc(src)) continue;
      let decoded = src;
      try {
        decoded = decodeURIComponent(src);
      } catch {
        // keep as-is
      }
      const abs = path.normalize(path.join(baseDir.replace(/\\/g, '/'), decoded.replace(/\\/g, '/')));
      let data: Buffer;
      try {
        data = await fs.readFile(abs);
      } catch {
        continue;
      }
      const name = await uniqueExportName(path.basename(abs), targetDir);
      await fs.writeFile(path.join(targetDir, name), data);
      replaced.set(src, 'assets/' + name);
    }
    if (replaced.size === 0) return html;
    let out = html;
    for (const [src, rel] of replaced) {
      out = out.split('src="' + src + '"').join('src="' + rel + '"');
    }
    return out;
  }

  ipcMain.handle(
    'export:pdf',
    async (_event, payload: { defaultName: string; html: string }): Promise<ExportResult> => {
      const win = mainWindow;
      if (!win) return { canceled: true, filePath: null };
      const result = await dialog.showSaveDialog(win, {
        title: '导出 PDF',
        defaultPath: payload.defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true, filePath: null };
      const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      const tmpDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'mymarkdown-export-'));
      try {
        const htmlPath = path.join(tmpDir, 'export.html');
        await fs.writeFile(htmlPath, payload.html, 'utf-8');
        await printWin.loadURL('file://' + htmlPath.replace(/\\/g, '/'));
        const pdf = await printWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
        });
        await fs.writeFile(result.filePath, pdf);
        return { canceled: false, filePath: result.filePath };
      } catch (error) {
        console.error('[export:pdf]', error);
        return { canceled: true, filePath: null };
      } finally {
        if (!printWin.isDestroyed()) printWin.destroy();
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  ipcMain.handle('theme:export', async (_event, payload: ThemeExportPayload): Promise<ExportResult> => {
    const win = mainWindow;
    if (!win) return { canceled: true, filePath: null };
    const safeName =
      String(payload.name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'MyMarkdown主题';
    const result = await dialog.showSaveDialog(win, {
      title: '导出样式文件',
      defaultPath: safeName + '.mmtheme',
      filters: [
        { name: 'MyMarkdown 样式', extensions: ['mmtheme'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true, filePath: null };
    const theme = {
      format: 'mymarkdown-theme',
      version: 2,
      name: safeName,
      base: payload.base ?? 'light',
      variables: payload.variables ?? {},
      customCss: payload.customCss ?? '',
      appVersion: app.getVersion(),
      exportedAt: new Date().toISOString(),
      settings: payload.settings ?? {},
      bgImageBase64: payload.bgImageBase64 ?? null,
    };
    try {
      await fs.writeFile(result.filePath, JSON.stringify(theme, null, 2), 'utf-8');
      return { canceled: false, filePath: result.filePath };
    } catch (error) {
      console.error('[theme:export]', error);
      return { canceled: true, filePath: null };
    }
  });

  ipcMain.handle('theme:import', async (): Promise<ThemeImportResult> => {
    const win = mainWindow;
    if (!win) return { canceled: true, error: '窗口不可用' };
    const result = await dialog.showOpenDialog(win, {
      title: '导入样式文件',
      properties: ['openFile'],
      filters: [
        { name: 'MyMarkdown 样式', extensions: ['mmtheme', 'json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const filePath = result.filePaths[0];
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        format?: unknown;
        version?: unknown;
        name?: unknown;
        base?: unknown;
        variables?: unknown;
        customCss?: unknown;
        settings?: unknown;
        bgImageBase64?: unknown;
      };
      if (data.format !== 'mymarkdown-theme') {
        return { canceled: false, error: '不是有效的 MyMarkdown 样式文件' };
      }
      if (!data.settings || typeof data.settings !== 'object') {
        return { canceled: false, error: '样式文件缺少 settings 内容' };
      }
      const settings = { ...(data.settings as Record<string, unknown>) };
      if (typeof data.bgImageBase64 === 'string' && data.bgImageBase64.startsWith('data:image/')) {
        const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(data.bgImageBase64);
        if (match) {
          let ext = match[1].toLowerCase();
          if (ext === 'jpeg') ext = 'jpg';
          if (!/^[a-z0-9]{1,8}$/.test(ext)) ext = 'png';
          const themesDir = path.join(app.getPath('userData'), 'themes');
          await fs.mkdir(themesDir, { recursive: true });
          const bgPath = path.join(themesDir, 'bg-' + Date.now() + '.' + ext);
          await fs.writeFile(bgPath, Buffer.from(match[2], 'base64'));
          settings.bgImage = bgPath;
        }
      }
      return {
        canceled: false,
        name: typeof data.name === 'string' ? data.name : '未命名样式',
        base:
          data.base === 'dark'
            ? 'dark'
            : settings.theme === 'dark'
              ? 'dark'
              : 'light',
        variables:
          data.variables && typeof data.variables === 'object'
            ? (data.variables as Record<string, string>)
            : {},
        customCss: typeof data.customCss === 'string' ? data.customCss : '',
        settings,
        bgImageBase64: typeof data.bgImageBase64 === 'string' ? data.bgImageBase64 : null,
      };
    } catch (error) {
      console.error('[theme:import]', error);
      return { canceled: false, error: '读取样式文件失败：' + (error instanceof Error ? error.message : String(error)) };
    }
  });

  ipcMain.handle('community:saveAuth', async (_event, auth: CommunityAuth): Promise<boolean> => {
    return saveCommunityAuthFile(auth);
  });

  ipcMain.handle('community:loadAuth', async (): Promise<CommunityAuth | null> => {
    try {
      const raw = await fs.readFile(communityAuthPath(), 'utf-8');
      const data = JSON.parse(raw) as Partial<CommunityAuth>;
      if (!data.baseUrl || !data.username) return null;
      return {
        baseUrl: String(data.baseUrl),
        username: String(data.username),
        password: typeof data.password === 'string' ? data.password : '',
        token: typeof data.token === 'string' ? data.token : '',
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('community:clearAuth', async (): Promise<boolean> => {
    try {
      await fs.rm(communityAuthPath(), { force: true });
      return true;
    } catch (error) {
      console.error('[community:clearAuth]', error);
      return false;
    }
  });

  ipcMain.handle('community:openBrowser', async (_event, url: string): Promise<void> => {
    try {
      const target = normalizeCommunityBaseUrl(String(url ?? ''));
      if (target) await shell.openExternal(target);
    } catch (error) {
      console.error('[community:openBrowser]', error);
    }
  });

  ipcMain.handle(
    'community:login',
    async (_event, auth: CommunityAuth): Promise<CommunityLoginResult> => {
      const baseUrl = normalizeCommunityBaseUrl(String(auth?.baseUrl ?? ''));
      const username = String(auth?.username ?? '').trim();
      const password = String(auth?.password ?? '');
      if (!baseUrl) return { ok: false, error: '社区服务器地址为空' };
      if (!username || !password) return { ok: false, error: '请输入用户名和密码' };
      const result = await loginToCommunity(baseUrl, username, password);
      if (!result.ok || !result.token) return result;
      await saveCommunityAuthFile({ baseUrl, username, password, token: result.token });
      return result;
    },
  );

  ipcMain.handle(
    'community:publish',
    async (_event, auth: CommunityAuth, payload: CommunityPublishPayload): Promise<CommunityPublishResult> => {
      const baseUrl = normalizeCommunityBaseUrl(String(auth?.baseUrl ?? ''));
      if (!baseUrl) return { ok: false, error: '社区服务器地址为空', needLogin: true };
      const doPublish = async (token: string): Promise<CommunityPublishResult> => {
        try {
          const res = await fetch(baseUrl + '/api/publish', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + token,
            },
            body: JSON.stringify({ client: 'desktop', ...payload }),
          });
          const data = (await res.json().catch(() => ({}))) as { error?: unknown };
          if (res.status === 401) return { ok: false, error: '登录已过期，请重新登录', needLogin: true };
          if (!res.ok) {
            return { ok: false, error: typeof data.error === 'string' ? data.error : '发布失败：' + res.status };
          }
          return { ok: true, data: data as Record<string, unknown> };
        } catch (error) {
          console.error('[community:publish]', error);
          return { ok: false, error: '无法连接社区服务器：' + (error instanceof Error ? error.message : String(error)) };
        }
      };
      const persistFreshToken = (token: string): Promise<boolean> =>
        saveCommunityAuthFile({ baseUrl, username: String(auth?.username ?? ''), password: String(auth?.password ?? ''), token });

      try {
        let token = auth.token ?? '';
        if (!token) {
          const firstLogin = await loginToCommunity(baseUrl, String(auth?.username ?? ''), String(auth?.password ?? ''));
          if (!firstLogin.ok || !firstLogin.token) {
            return { ok: false, error: firstLogin.error ?? '登录失败', needLogin: true };
          }
          token = firstLogin.token;
          await persistFreshToken(token);
        }
        const first = await doPublish(token);
        if (first.ok || !first.needLogin) return first;
        const relogin = await loginToCommunity(baseUrl, String(auth?.username ?? ''), String(auth?.password ?? ''));
        if (!relogin.ok || !relogin.token) {
          return { ok: false, error: relogin.error ?? '登录失败', needLogin: true };
        }
        await persistFreshToken(relogin.token);
        return await doPublish(relogin.token);
      } catch (error) {
        console.error('[community:publish]', error);
        return { ok: false, error: '发布失败：' + (error instanceof Error ? error.message : String(error)) };
      }
    },
  );
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = findFileFromArgv(argv);
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (filePath) pendingOpenPath = filePath;
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (filePath) queueOpenFile(filePath);
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    queueOpenFile(filePath);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.mymarkdown.desktop');
    registerAppProtocol();
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}