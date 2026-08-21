import './style.css';
import type { Editor } from '@milkdown/kit/core';
import { TextSelection, AllSelection, NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import type { MarkType, Node, NodeType } from '@milkdown/kit/prose/model';
import { lift, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import {
  CellSelection,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  mergeCells,
  selectedRect,
  splitCell,
} from '@milkdown/kit/prose/tables';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { CommunityAuth, CommunityPublishPayload, FileEntry, MarkdownApi } from '../shared/api';
import {
  createEditor,
  deleteCodeBlockRange,
  findImageAtPos,
  getEditorHtml,
  getEditorView,
  insertImageAtCursor,
  invalidateDocCache,
  removeImageAt,
  resolveImageFilePath,
  searchKey,
  setEditorContent,
  setImageBaseDir,
  setImageAlign,
  setImageWidth,
  updateImageSrc,
} from './editor';
import { FileTree, type TreeCallbacks } from './tree';
import { basename, buildExportHtml, countStats, dirname, escapeHtml, inlineImagesInHtml } from './export';
import { applySettingsToDom, getSettings, resetSettings, resetSettingsGroup, saveSettings, subscribeSettings, type AppSettings, type SettingsGroup } from './settings';
import { activateTheme, applyTheme, createTheme, deleteTheme, getActiveTheme, getTheme, listThemes, saveTheme, MAX_BG_DATA_LEN, type ThemeDef } from './themes';
import type { ExportResult } from '../shared/api';

declare global {
  interface Window {
    api: MarkdownApi;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

interface AppState {
  editor: Editor | null;
  folderPath: string | null;
  currentFile: string | null;
  markdown: string;
  loading: boolean;
  suppressSaveUntil: number;
  dirty: boolean;
  tree: FileTree | null;
}

const state: AppState = {
  editor: null,
  folderPath: null,
  currentFile: null,
  markdown: '',
  loading: false,
  suppressSaveUntil: 0,
  dirty: false,
  tree: null,
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOpenFile: string | null = null;
let osPendingOpen: string | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let prevOpenClickAt = 0;
let folderOpenRunning: Promise<void> = Promise.resolve();
let lastSetMarkdown: string | null = null;
let clipboardEntry: { path: string; name: string; isDir: boolean } | null = null;
let selectedImagePos: number | null = null;

// 粗略检测二进制/非文本内容：前 8KB 里控制字符较多即视为二进制
function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true;
  let control = 0;
  const sample = Math.min(text.length, 8192);
  for (let i = 0; i < sample; i++) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) control++;
  }
  return control > 10;
}

function show(el: HTMLElement): void {
  el.classList.remove('hidden');
}

function hide(el: HTMLElement): void {
  el.classList.add('hidden');
}

function showWelcome(): void {
  hide($('editor-wrap'));
  show($('welcome'));
}

function showEditorArea(): void {
  hide($('welcome'));
  show($('editor-wrap'));
}

function updateButtons(): void {
  // 「新建」始终可用：未打开文件夹时点击会自动先选择文件夹
  ($('btn-new-file') as HTMLButtonElement).disabled = false;
  ($('btn-save') as HTMLButtonElement).disabled = !state.folderPath || !state.currentFile;
  ($('btn-export') as HTMLButtonElement).disabled = !state.currentFile;
}

async function newFileSmart(): Promise<void> {
  if (!state.folderPath) {
    const folder = await window.api.openFolder();
    if (!folder) return;
    await openFolder(false, folder);
  }
  newFileInline(state.folderPath!);
}

function setStatus(text: string, kind: 'idle' | 'saved' | 'saving' | 'error' = 'idle'): void {
  const el = $('stat-save');
  el.textContent = text;
  el.dataset.kind = kind;
}

function updateStats(markdown: string): void {
  const { chars, words } = countStats(markdown);
  $('stat-count').textContent = `字符 ${chars} · 单词 ${words}`;
}

function updateTitle(filePath: string): void {
  const name = basename(filePath);
  document.title = `${name} - MyMarkdown`;
  const label = $('current-file');
  label.textContent = name;
  label.title = filePath;
  $('stat-path').textContent = filePath;
}

function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function applyDarkMode(dark: boolean): void {
  saveSettings({ theme: dark ? 'dark' : 'light' });
}

function toggleTheme(): void {
  const dark = !document.body.classList.contains('dark');
  activateTheme(dark ? 'builtin-dark' : 'builtin-light');
  applyDarkMode(dark);
  syncThemeBgSettings();
  ensureThemeEditorSynced();
}

async function openFolder(fromDialog = true, folderPath?: string, initialFile?: string): Promise<void> {
  let folder = folderPath;
  if (fromDialog) folder = (await window.api.openFolder()) ?? undefined;
  if (!folder) return;
  state.folderPath = folder;
  setImageBaseDir(folder);
  localStorage.setItem('lastFolder', folder);
  // 切换目录时先清空旧的编辑状态，避免残留上一个目录的文件内容
  state.currentFile = null;
  state.markdown = '';
  state.dirty = false;
  if (state.editor) {
    setEditorContent(state.editor, '');
    lastSetMarkdown = '';
  }
  document.title = 'MyMarkdown';
  $('current-file').textContent = '';
  $('stat-path').textContent = '';
  setStatus('', 'idle');
  updateStats('');
  if (!state.tree) {
    state.tree = new FileTree($('file-tree'), window.api, treeCallbacks);
  }
  await state.tree.setRoot(folder);
  $('folder-name').textContent = basename(folder);
  showEditorArea();
  updateButtons();

  const lastFile = initialFile ?? localStorage.getItem('lastFile');
  if (lastFile && (lastFile.startsWith(folder + '\\') || lastFile.startsWith(folder + '/'))) {
    try {
      await openFile(lastFile);
      return;
    } catch {
      // 文件可能已被删除，继续尝试打开第一个文件
    }
  }
  const first = state.tree.firstMarkdownFile();
  if (first) {
    await openFile(first);
  } else {
    setStatus('文件夹中没有 Markdown 文件，点击「新建」开始', 'idle');
  }
}

function enqueueFolderOpen(folder: string, initialFile?: string): Promise<void> {
  const next = folderOpenRunning.then(() => openFolder(false, folder, initialFile));
  folderOpenRunning = next.catch(() => undefined);
  return next;
}

async function openFile(filePath: string): Promise<void> {
  if (state.currentFile === filePath) return;
  const fileDir = dirname(filePath);
  if (fileDir) setImageBaseDir(fileDir);
  // 正在加载时只记录目标，加载完自动打开，避免快速点击堆积卡顿
  if (state.loading) {
    pendingOpenFile = filePath;
    return;
  }
  // 同步置位，避免 await 期间多个点击并发进入
  state.loading = true;
  state.suppressSaveUntil = Date.now() + 600;
  setStatus('打开中…', 'idle');
  await flushSave();
  try {
    const content = await window.api.readFile(filePath);
    state.currentFile = filePath;
    localStorage.setItem('lastFile', filePath);
    state.markdown = content;
    if (state.editor) {
      if (looksBinary(content)) {
        // 二进制文件不解析，避免大段垃圾内容阻塞主线程
        toast('该文件不是纯文本，无法预览');
        setEditorContent(state.editor, '');
        lastSetMarkdown = '';
      } else {
        if (content.length > 200000) {
          // 大文件：先让出事件循环，让排队的点击先处理，再解析
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        setEditorContent(state.editor, content, filePath);
        lastSetMarkdown = content;
      }
    }
    state.dirty = false;
    updateTitle(filePath);
    setStatus('已打开', 'idle');
    updateStats(content);
    state.tree?.setActive(filePath);
    showEditorArea();
    updateButtons();
  } catch (error) {
    toast(`无法打开文件：${(error as Error).message}`);
  } finally {
    state.loading = false;
    if (pendingOpenFile) {
      if (openTimer) clearTimeout(openTimer);
      if (performance.now() - prevOpenClickAt < 200) {
        // 用户仍在快速点击：再等一小段，让最后一次点击合并进来
        openTimer = setTimeout(flushPendingOpen, 120);
      } else {
        // 已停止点击：立即打开排队的文件，不再额外等待
        flushPendingOpen();
      }
    }
  }
}

function flushPendingOpen(): void {
  openTimer = null;
  const next = pendingOpenFile;
  pendingOpenFile = null;
  if (next) void openFile(next);
}

// 快速连点时只打开最后一个文件，避免逐文件串行加载造成的卡顿
function requestOpenFile(filePath: string): void {
  if (IMAGE_NAME_RE.test(filePath)) {
    void window.api.openImageExternally(filePath);
    return;
  }
  if (state.currentFile === filePath) return;
  // 左侧立即高亮选中，点击即有反馈；打开完成后右侧再更新内容
  state.tree?.setActive(filePath);
  const now = performance.now();
  const rapid = now - prevOpenClickAt < 250;
  prevOpenClickAt = now;
  pendingOpenFile = filePath;
  if (openTimer) clearTimeout(openTimer);
  if (rapid || state.loading) {
    // 连点或加载中：等停顿后再打开，期间新的点击会替换目标
    openTimer = setTimeout(flushPendingOpen, 120);
  } else {
    pendingOpenFile = null;
    void openFile(filePath);
  }
}

function handleOsOpenFile(filePath: string): void {
  if (IMAGE_NAME_RE.test(filePath)) {
    void window.api.openImageExternally(filePath);
    return;
  }
  const folder = state.folderPath;
  if (!folder) {
    osPendingOpen = filePath;
    return;
  }
  const dir = dirname(filePath);
  if (!dir) return;
  const normFolder = folder.replace(/[\\/]+$/, '');
  if (dir === folder || dir === normFolder) {
    requestOpenFile(filePath);
  } else {
    void enqueueFolderOpen(dir, filePath);
  }
}
function handleMarkdownChange(markdown: string): void {
  state.markdown = markdown;
  updateStats(markdown);
  // 用户真实编辑（非 setEditorContent 触发）时，使该文件解析缓存失效
  if (markdown !== lastSetMarkdown && state.currentFile) {
    invalidateDocCache(state.currentFile);
  }
  if (state.loading || Date.now() < state.suppressSaveUntil) return;
  if (!state.currentFile) return;
  if (!state.dirty) {
    state.dirty = true;
    setStatus('未保存', 'saving');
  }
  scheduleSave();
}

let autoSaveInterval: ReturnType<typeof setInterval> | null = null;

function stopAutoSave(): void {
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
  }
}

function syncAutoSave(): void {
  stopAutoSave();
  if (getSettings().saveMode === 'manual') return;
  const minutes = Math.max(1, Math.round(getSettings().autoSaveMinutes));
  autoSaveInterval = setInterval(() => {
    if (state.currentFile && state.dirty) void saveFile();
  }, minutes * 60 * 1000);
}

function scheduleSave(): void {
  if (getSettings().saveMode === 'manual') return;
  if (!autoSaveInterval) syncAutoSave();
}


async function saveFile(): Promise<void> {
  if (!state.currentFile) return;
  setStatus('保存中…', 'saving');
  const ok = await window.api.writeFile(state.currentFile, state.markdown);
  if (ok) {
    state.dirty = false;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    setStatus(`已保存 ${hh}:${mm}:${ss}`, 'saved');
  } else {
    setStatus('保存失败', 'error');
    toast('保存失败，请重试');
  }
}

async function flushSave(): Promise<void> {
  stopAutoSave();
  if (state.currentFile && state.dirty) {
    await saveFile();
  }
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/apng': '.apng',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/jxl': '.jxl',
};
const IMAGE_NAME_RE =
  /\.(png|jpe?g|jpe|jfif|pjpe?g|gif|webp|avif|apng|bmp|dib|svgz?|ico|cur|tiff?|heic|heif|heics|heifs|jxl|psd|xcf|exr|hdr|pcx|tga|dds|pnm|pgm|ppm|pbm|pam|qoi|wbmp|cr2|cr3|nef|arw|dng|rw2|orf|pef|srw|raf)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_NAME_RE.test(file.name);
}

function imageExtFrom(file: File): string {
  const fromMime = IMAGE_MIME_EXT[file.type];
  if (fromMime) return fromMime;
  const match = /\.([a-z0-9]{1,10})$/i.exec(file.name);
  return match ? '.' + match[1].toLowerCase() : '.png';
}

function pathSepOf(dir: string): string {
  return dir.includes('\\') ? '\\' : '/';
}

function imageTargetDir(): string | null {
  const base = state.currentFile ? dirname(state.currentFile) ?? state.folderPath : state.folderPath;
  if (!base) return null;
  const mode = getSettings().imageStoreMode;
  if (mode === 'same') return base;
  const sep = pathSepOf(base);
  if (mode === 'file' && state.currentFile) {
    const mdName = basename(state.currentFile).replace(/\.(md|markdown|txt)$/i, '');
    if (mdName) return base + sep + mdName + '.assets';
  }
  return base + sep + 'assets';
}

function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  const seen = new Set<string>();
  if (dt.files) {
    for (const file of Array.from(dt.files)) {
      if (isImageFile(file)) {
        files.push(file);
        seen.add(file.name + ':' + file.size);
      }
    }
  }
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file || !isImageFile(file)) continue;
      const key = file.name + ':' + file.size;
      if (!seen.has(key)) {
        files.push(file);
        seen.add(key);
      }
    }
  }
  return files;
}

function dataTransferHasImage(dt: DataTransfer): boolean {
  return Array.from(dt.items).some((item) => {
    if (item.kind !== 'file') return false;
    if (item.type.startsWith('image/')) return true;
    const file = item.getAsFile();
    return !!file && isImageFile(file);
  });
}

function toRelativeSrc(dir: string, filePath: string): string {
  const base = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = filePath.replace(/\\/g, '/');
  if (file.startsWith(base + '/')) return file.slice(base.length + 1);
  return file;
}

type ContextMenuItem =
  | [string, () => void]
  | {
      label: string;
      action?: () => void;
      submenu?: Array<[string, () => void] | { separator: true }>;
      disabled?: boolean;
    }
  | { separator: true };

function buildContextMenu(items: ContextMenuItem[], x: number, y: number): void {
  const menu = $('context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    if (Array.isArray(item)) {
      const [label, action] = item;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        hideContextMenu();
        action();
      });
      menu.appendChild(button);
    } else if (item.submenu) {
      const wrap = document.createElement('div');
      wrap.className = 'menu-sub-wrap';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label + ' ▸';
      if (item.disabled) button.disabled = true;
      wrap.appendChild(button);
      const sub = document.createElement('div');
      sub.className = 'context-submenu';
      for (const subItem of item.submenu) {
        if ('separator' in subItem) {
          const sep = document.createElement('div');
          sep.className = 'menu-sep';
          sub.appendChild(sep);
          continue;
        }
        const [label, action] = subItem;
        const subButton = document.createElement('button');
        subButton.type = 'button';
        subButton.textContent = label;
        subButton.addEventListener('click', () => {
          hideContextMenu();
          action();
        });
        sub.appendChild(subButton);
      }
      wrap.appendChild(sub);
      menu.appendChild(wrap);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      if (item.disabled) button.disabled = true;
      button.addEventListener('click', () => {
        hideContextMenu();
        item.action?.();
      });
      menu.appendChild(button);
    }
  }
  show(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}
type TableCommand = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

function applyTableCommand(cmd: TableCommand): boolean {
  if (!state.editor) return false;
  const view = getEditorView(state.editor);
  view.focus();
  return cmd(view.state, view.dispatch);
}

function currentCellAlignment(attr: 'alignment' | 'verticalAlign'): string {
  const fallback = attr === 'alignment' ? 'left' : 'top';
  if (!state.editor) return fallback;
  const view = getEditorView(state.editor);
  try {
    const rect = selectedRect(view.state);
    const cellPos = rect.map.cellsInRect({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.top + 1,
    })[0];
    const cell = rect.table.nodeAt(cellPos);
    const value = cell ? String(cell.attrs[attr] ?? '') : '';
    return value || fallback;
  } catch {
    return fallback;
  }
}

function setCellAlignment(attr: 'alignment' | 'verticalAlign', value: string): boolean {
  if (!state.editor) return false;
  const view = getEditorView(state.editor);
  view.focus();
  try {
    const rect = selectedRect(view.state);
    const cells = rect.map.cellsInRect({
      left: rect.left,
      right: rect.right,
      top: 0,
      bottom: rect.map.height,
    });
    let tr = view.state.tr;
    for (const cellPos of cells) {
      const pos = cellPos + rect.tableStart;
      const cell = tr.doc.nodeAt(pos);
      if (!cell) continue;
      tr = tr.setNodeMarkup(pos, undefined, { ...cell.attrs, [attr]: value });
    }
    view.dispatch(tr);
    updateFormatBar();
    return tr.docChanged;
  } catch {
    return false;
  }
}

function showTableContextMenu(x: number, y: number): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  const sel = view.state.selection;
  const inTable = isInTable(view.state);
  const multiCell = sel instanceof CellSelection && sel.$anchorCell.pos !== sel.$headCell.pos;
  const hAlign = currentCellAlignment('alignment');
  const vAlign = currentCellAlignment('verticalAlign');
  const items: ContextMenuItem[] = [
    { label: '合并单元格', disabled: !multiCell, action: () => void applyTableCommand(mergeCells) },
    { label: '拆分单元格', disabled: !inTable, action: () => void applyTableCommand(splitCell) },
    { separator: true },
    {
      label: '插入',
      disabled: !inTable,
      submenu: [
        ['在上方插入行', () => void applyTableCommand(addRowBefore)],
        ['在下方插入行', () => void applyTableCommand(addRowAfter)],
        ['在左侧插入列', () => void applyTableCommand(addColumnBefore)],
        ['在右侧插入列', () => void applyTableCommand(addColumnAfter)],
      ],
    },
    {
      label: '删除',
      disabled: !inTable,
      submenu: [
        ['删除行', () => void applyTableCommand(deleteRow)],
        ['删除列', () => void applyTableCommand(deleteColumn)],
        ['删除表格', () => void applyTableCommand(deleteTable)],
      ],
    },
    {
      label: '对齐方式',
      disabled: !inTable,
      submenu: [
        ['左对齐' + (hAlign === 'left' ? '  ✓' : ''), () => void setCellAlignment('alignment', 'left')],
        ['居中' + (hAlign === 'center' ? '  ✓' : ''), () => void setCellAlignment('alignment', 'center')],
        ['右对齐' + (hAlign === 'right' ? '  ✓' : ''), () => void setCellAlignment('alignment', 'right')],
        { separator: true },
        ['靠上' + (vAlign === 'top' ? '  ✓' : ''), () => void setCellAlignment('verticalAlign', 'top')],
        ['垂直居中' + (vAlign === 'middle' ? '  ✓' : ''), () => void setCellAlignment('verticalAlign', 'middle')],
        ['靠下' + (vAlign === 'bottom' ? '  ✓' : ''), () => void setCellAlignment('verticalAlign', 'bottom')],
      ],
    },
  ];
  buildContextMenu(items, x, y);
}
// 判断右键位置是否落在代码块上；命中则返回可删除的范围（含头部工具栏等非内容区域）
function codeBlockRangeAt(target: Element, x: number, y: number): { from: number; to: number } | null {
  if (!state.editor) return null;
  const view = getEditorView(state.editor);
  const coords = view.posAtCoords({ left: x, top: y });
  if (coords) {
    const $pos = view.state.doc.resolve(coords.pos);
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === 'code_block') return { from: $pos.before(d), to: $pos.after(d) };
    }
    if ($pos.nodeAfter?.type.name === 'code_block') return { from: coords.pos, to: coords.pos + $pos.nodeAfter.nodeSize };
    if ($pos.nodeBefore?.type.name === 'code_block') return { from: coords.pos - $pos.nodeBefore.nodeSize, to: coords.pos };
  }
  const blockEl = target.closest<HTMLElement>('.mm-code');
  if (blockEl) {
    const pos = view.posAtDOM(blockEl, 0);
    const nodeAfter = view.state.doc.resolve(pos).nodeAfter;
    if (nodeAfter?.type.name === 'code_block') return { from: pos, to: pos + nodeAfter.nodeSize };
  }
  return null;
}

function showEditorContextMenu(target: Element, x: number, y: number): void {
  const items: ContextMenuItem[] = [];
  const codeRange = codeBlockRangeAt(target, x, y);
  if (codeRange) {
    items.push(['删除代码块', () => void deleteCodeBlockRange(getEditorView(state.editor!), codeRange.from, codeRange.to)]);
    items.push({ separator: true });
  }
  items.push(
    ['插入图片…', () => void insertImageFromDialog()],
    ['插入表格…', () => {
      if (!state.editor) return;
      getEditorView(state.editor).focus();
      insertTableCommand.run({ row: 3, col: 3 });
    }],
  );
  buildContextMenu(items, x, y);
}

function currentImageAlign(): 'left' | 'right' | 'center' {
  const img = document.querySelector<HTMLImageElement>('#editor img.mymarkdown-img-el.mymarkdown-img-selected');
  if (!img) return 'center';
  const styleText = (img.getAttribute('style') ?? '') + ';' + (img.style.cssText ?? '');
  if (/\bfloat\s*:\s*left/i.test(styleText)) return 'left';
  if (/\bfloat\s*:\s*right/i.test(styleText)) return 'right';
  return 'center';
}

function showImageContextMenu(x: number, y: number): void {
  const align = currentImageAlign();
  const img = document.querySelector<HTMLImageElement>('#editor img.mymarkdown-img-el.mymarkdown-img-selected');
  const pct = img ? currentWidthPct(img) : null;
  const widthItem = (v: number): string => v + '%' + (pct === v ? '  ✓' : '');
  const items: ContextMenuItem[] = [
    ['复制图片', () => void copySelectedImage()],
    ['替换图片…', () => void replaceSelectedImage()],
    ['在新窗口打开', () => void openSelectedImage()],
    { separator: true },
    {
      label: '宽度',
      submenu: [
        [widthItem(25), () => setSelectedImageWidth(25)],
        [widthItem(50), () => setSelectedImageWidth(50)],
        [widthItem(75), () => setSelectedImageWidth(75)],
        [widthItem(100), () => setSelectedImageWidth(100)],
      ],
    },
    {
      label: '对齐方式',
      submenu: [
        ['左对齐' + (align === 'left' ? '  ✓' : ''), () => setSelectedImageAlign('left')],
        ['居中' + (align === 'center' ? '  ✓' : ''), () => setSelectedImageAlign('center')],
        ['右对齐' + (align === 'right' ? '  ✓' : ''), () => setSelectedImageAlign('right')],
      ],
    },
    { separator: true },
    ['删除图片', () => void deleteSelectedImage(false)],
    ['仅移除引用', () => void deleteSelectedImage(true)],
  ];
  buildContextMenu(items, x, y);
}

function setSelectedImageAlign(align: 'left' | 'right' | 'center'): void {
  if (selectedImagePos == null || !state.editor) return;
  setImageAlign(state.editor, selectedImagePos, align);
}

function clearSelectedImage(): void {
  selectedImagePos = null;
  document
    .querySelectorAll('#editor img.mymarkdown-img-el')
    .forEach((el) => el.classList.remove('mymarkdown-img-selected'));
  document
    .querySelectorAll('#editor .mymarkdown-img.selected')
    .forEach((el) => el.classList.remove('selected'));
}

function selectEditorImage(img: HTMLImageElement): void {
  clearSelectedImage();
  img.classList.add('mymarkdown-img-selected');
  const wrapper = img.closest<HTMLElement>('.mymarkdown-img');
  if (wrapper) wrapper.classList.add('selected');
  if (state.editor) {
    try {
      selectedImagePos = getEditorView(state.editor).posAtDOM(img, 0);
    } catch {
      selectedImagePos = null;
    }
  }
}

function currentWidthPct(img: HTMLImageElement): number | null {
  const styleText = (img.getAttribute('style') ?? '') + ';' + (img.style.cssText ?? '');
  const m = /width\s*:\s*(\d+(?:\.\d+)?)%/i.exec(styleText);
  return m ? Math.round(Number(m[1])) : null;
}

function startImageResize(event: MouseEvent, img: HTMLImageElement): void {
  const paragraph = img.closest('p');
  const containerWidth = paragraph?.clientWidth || img.parentElement?.clientWidth || img.clientWidth || 800;
  const startX = event.clientX;
  const startPct = currentWidthPct(img) ?? 100;
  const onMove = (moveEvent: MouseEvent) => {
    const dx = moveEvent.clientX - startX;
    const pct = Math.max(10, Math.min(100, Math.round(startPct + (dx / containerWidth) * 100)));
    img.style.width = pct + '%';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!state.editor || selectedImagePos == null) return;
    const width = currentWidthPct(img) ?? 100;
    setImageWidth(state.editor, selectedImagePos, width);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function selectedImageInfo(): { src: string; filePath: string | null } | null {
  if (selectedImagePos == null || !state.editor) return null;
  const hit = findImageAtPos(state.editor, selectedImagePos);
  if (!hit) return null;
  return { src: hit.src, filePath: resolveImageFilePath(hit.src) };
}

async function copySelectedImage(): Promise<void> {
  const info = selectedImageInfo();
  if (!info || !info.filePath) {
    toast('无法定位图片文件');
    return;
  }
  const ok = await window.api.copyImageToClipboard(info.filePath);
  toast(ok ? '已复制图片' : '复制失败：格式不受支持');
}

async function openSelectedImage(): Promise<void> {
  const info = selectedImageInfo();
  if (!info || !info.filePath) {
    toast('无法定位图片文件');
    return;
  }
  await window.api.openImageExternally(info.filePath);
}

function setSelectedImageWidth(pct: number): void {
  if (selectedImagePos == null || !state.editor) return;
  setImageWidth(state.editor, selectedImagePos, pct);
}

async function replaceSelectedImage(): Promise<void> {
  if (selectedImagePos == null || !state.editor) return;
  const info = selectedImageInfo();
  if (!info || !info.filePath) {
    toast('无法定位图片文件');
    return;
  }
  const picked = await window.api.openImage();
  if (!picked) return;
  const file = await window.api.readImageFile(picked);
  if (!file) {
    toast('读取图片失败');
    return;
  }
  const oldExt = (/\.([a-z0-9]{1,10})$/i.exec(info.filePath)?.[1] ?? '').toLowerCase();
  const newExt = (/\.([a-z0-9]{1,10})$/i.exec(file.name)?.[1] ?? '').toLowerCase();
  const data = file.data.slice();
  if (oldExt && newExt && oldExt === newExt) {
    const ok = await window.api.writeImageFile(info.filePath, data);
    toast(ok ? '已替换图片' : '替换失败');
    if (ok) {
      const img = document.querySelector<HTMLImageElement>('#editor img.mymarkdown-img-el.mymarkdown-img-selected');
      if (img) img.src = img.src;
    }
    return;
  }
  const oldDir = dirname(info.filePath);
  if (!oldDir) {
    toast('无法定位图片目录');
    return;
  }
  const saved = await window.api.saveImage({ data, dir: oldDir, name: file.name, ext: newExt ? '.' + newExt : '.png' });
  if (!saved) {
    toast('保存图片失败');
    return;
  }
  const baseDir = imageTargetDir();
  if (baseDir) {
    updateImageSrc(state.editor, selectedImagePos, encodeURI(toRelativeSrc(baseDir, saved)));
    toast('已替换图片（新文件）');
  }
}

async function deleteSelectedImage(keepFile: boolean): Promise<void> {
  if (selectedImagePos == null || !state.editor) return;
  const info = selectedImageInfo();
  if (!info) return;
  const name = info.src.split(/[\\/]/).filter(Boolean).pop() ?? '图片';
  if (!keepFile && info.filePath) {
    const refs = countImageReferences(name);
    const ok = await confirmModal(
      '删除图片',
      '确定删除“' + name + '”吗？\n当前文档引用 ' + refs + ' 处。此操作无法恢复。',
    );
    if (!ok) return;
    await window.api.deleteFile(info.filePath);
  }
  removeImageAt(state.editor, selectedImagePos);
  selectedImagePos = null;
  toast(keepFile ? '已移除引用' : '已删除图片');
}

// 文档中最后一个非空文本块（段落/列表项/引用块等）的末尾位置
function endOfLastContentBlock(doc: Node): number {
  let end = 0;
  doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent.trim() !== '') {
      end = pos + node.nodeSize - 1;
    }
    return false;
  });
  return end === 0 ? doc.content.size : end;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countImageReferences(name: string): number {
  if (!state.currentFile || !name) return 0;
  const variants = [name];
  const encoded = encodeURI(name);
  if (encoded !== name) variants.push(encoded);
  let count = 0;
  for (const variant of variants) {
    const matches = state.markdown.match(new RegExp(escapeRegExp(variant), 'g'));
    count += matches?.length ?? 0;
  }
  return count;
}

async function insertImageFromDialog(): Promise<void> {
  if (!state.editor) return;
  const picked = await window.api.openImage();
  if (!picked) return;
  const file = await window.api.readImageFile(picked);
  if (!file) {
    toast('读取图片失败');
    return;
  }
  await handleImageFiles([new File([file.data.slice()], file.name, { type: file.type })]);
}

async function handleImageFiles(files: File[]): Promise<void> {
  if (!state.editor) return;
  const dir = imageTargetDir();
  if (!dir) {
    toast('请先打开文件夹，再粘贴/拖入图片');
    return;
  }
  setImageBaseDir(dir);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const saved = await window.api.saveImage({ data, dir, name: file.name, ext: imageExtFrom(file) });
      if (!saved) {
        toast('保存图片失败');
        continue;
      }
      insertImageAtCursor(state.editor, encodeURI(toRelativeSrc(dir, saved)), index > 0);
      toast('已插入图片：' + basename(saved));
    } catch (error) {
      console.error('[insert-image]', error);
      toast('插入图片失败');
    }
  }
}

async function createFileUnique(dir: string, name: string): Promise<string | null> {
  const extMatch = /\.(md|markdown|txt)$/i.exec(name);
  const ext = extMatch?.[0] ?? '.md';
  const base = extMatch ? name.slice(0, name.length - ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${base} ${i}${ext}`;
    const created = await window.api.createFile(dir, candidate);
    if (created) return created;
  }
  return null;
}

function newFileInline(dir: string): void {
  state.tree?.insertNewFileInput(dir);
}

function newFolderInline(dir: string): void {
  state.tree?.insertNewFolderInput(dir);
}

async function createDirUnique(dir: string, name: string): Promise<string | null> {
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${name} ${i}`;
    const created = await window.api.createDir(dir, candidate);
    if (created) return created;
  }
  return null;
}

async function deleteNode(node: FileEntry): Promise<void> {
  const refCount = node.isImage ? countImageReferences(node.name) : 0;
  const message = node.isImage
    ? '确定要删除“' + node.name + '”吗？\n当前文档引用 ' + refCount + ' 处。此操作无法恢复。'
    : '确定要删除“' + node.name + '”吗？此操作无法恢复。';
  const confirmed = await confirmModal('删除文件', message);
  if (!confirmed) return;
  const ok = await window.api.deleteFile(node.path);
  if (!ok) {
    toast('删除失败');
    return;
  }
  if (state.currentFile === node.path) {
    state.currentFile = null;
    state.dirty = false;
    state.markdown = '';
    document.title = 'MyMarkdown';
    $('current-file').textContent = '';
    $('stat-path').textContent = '';
    setStatus('', 'idle');
    updateStats('');
    showWelcome();
    updateButtons();
  }
  await state.tree?.refresh();
}

async function doExport(kind: 'md' | 'html-copy' | 'html-inline' | 'pdf'): Promise<void> {
  if (!state.currentFile || !state.editor) {
    toast('请先打开一个文件');
    return;
  }
  await flushSave();
  const base = basename(state.currentFile).replace(/\.(md|markdown|txt)$/i, '');
  try {
    if (kind === 'md') {
      const result = await window.api.exportMarkdown(base + '.md', state.markdown);
      if (result.filePath) toast('已导出：' + basename(result.filePath));
      return;
    }
    const bodyHtml = await getEditorHtml(state.editor);
    let doc: string;
    let result: ExportResult;
    if (kind === 'html-copy') {
      doc = buildExportHtml(base, bodyHtml);
      result = await window.api.exportHtml(base + '.html', doc, { baseDir: imageTargetDir() });
    } else {
      const inlined = await inlineImagesInHtml(
        bodyHtml,
        imageTargetDir(),
        (filePath) => window.api.readImageDataUrl(filePath),
      );
      doc = buildExportHtml(base, inlined);
      result =
        kind === 'html-inline'
          ? await window.api.exportHtml(base + '.html', doc)
          : await window.api.exportPdf(base + '.pdf', doc);
    }
    if (result.filePath) toast('已导出：' + basename(result.filePath));
  } catch (error) {
    toast(`导出失败：${(error as Error).message}`);
  }
}

function confirmModal(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = $('modal-mask');
    const modal = $('modal');
    modal.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-danger" data-act="ok">删除</button>
      </div>`;
    show(mask);
    const cleanup = () => hide(mask);
    modal.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });
    modal.querySelector('[data-act="ok"]')?.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });
    mask.addEventListener('click', (event) => {
      if (event.target === mask) {
        cleanup();
        resolve(false);
      }
    });
  });
}

function copyToClipboard(node: FileEntry): void {
  clipboardEntry = { path: node.path, name: node.name, isDir: node.isDir };
  toast(`已复制：${node.name}`);
}

async function pasteEntry(targetDir: string): Promise<void> {
  if (!clipboardEntry) {
    toast('请先复制一个文件或文件夹');
    return;
  }
  const target = await window.api.copyEntry(clipboardEntry.path, targetDir);
  if (!target) {
    toast('粘贴失败');
    return;
  }
  toast(`已粘贴：${basename(target)}`);
  await state.tree?.refresh();
}

function showContextMenu(node: FileEntry, x: number, y: number): void {
  const menu = $('context-menu');
  menu.innerHTML = '';
  const items: Array<[string, () => void]> = [];
  if (node.isDir) {
    items.push(['新建文件', () => newFileInline(node.path)]);
    items.push(['新建文件夹', () => newFolderInline(node.path)]);
    items.push(['复制', () => copyToClipboard(node)]);
    items.push(['粘贴', () => void pasteEntry(node.path)]);
    items.push(['重命名', () => state.tree?.startRename(node)]);
  } else if (node.isImage) {
    items.push(['在新窗口打开', () => void window.api.openImageExternally(node.path)]);
    items.push(['复制', () => copyToClipboard(node)]);
    items.push(['粘贴', () => {
      const parent = dirname(node.path);
      if (parent) void pasteEntry(parent);
    }]);
    items.push(['重命名', () => state.tree?.startRename(node)]);
    items.push(['删除', () => void deleteNode(node)]);
  } else {
    items.push(['打开', () => void openFile(node.path)]);
    items.push(['复制', () => copyToClipboard(node)]);
    items.push(['粘贴', () => {
      const parent = dirname(node.path);
      if (parent) void pasteEntry(parent);
    }]);
    items.push(['重命名', () => state.tree?.startRename(node)]);
    items.push(['删除', () => void deleteNode(node)]);
  }
  for (const [label, action] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      hideContextMenu();
      action();
    });
    menu.appendChild(button);
  }
  show(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function hideContextMenu(): void {
  hide($('context-menu'));
}

const treeCallbacks: TreeCallbacks = {
  onOpenFile: (path) => requestOpenFile(path),
  onNewFile: async (dir, name) => {
    return await createFileUnique(dir, name);
  },
  onNewFolder: async (dir, name) => {
    return await createDirUnique(dir, name);
  },
  onRename: async (node, newName) => {
    const target = await window.api.renameFile(node.path, newName);
    if (!target) {
      toast('重命名失败：名称无效或文件已存在');
      return false;
    }
    if (state.currentFile === node.path) {
      state.currentFile = target;
      localStorage.setItem('lastFile', target);
      updateTitle(target);
    }
    if (node.isImage && countImageReferences(node.name) > 0) {
      toast('注意：文档中的图片引用可能已失效');
    }
    await state.tree?.refresh();
    return true;
  },
  onDeleteFile: (node) => void deleteNode(node),
  onContextMenu: (node, x, y) => showContextMenu(node, x, y),
};

/* ---------- 格式工具栏 ---------- */

function promptModal(title: string, placeholder: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = $('modal-mask');
    const modal = $('modal');
    modal.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      <p style="margin: 0 0 18px">
        <input
          id="prompt-input"
          class="inline-input"
          style="width: 100%; padding: 8px 10px; font-size: 14px"
          placeholder="${escapeHtml(placeholder)}"
          value="${escapeHtml(initial)}"
        />
      </p>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-primary" data-act="ok">确定</button>
      </div>`;
    show(mask);
    const input = modal.querySelector<HTMLInputElement>('#prompt-input');
    if (!input) {
      resolve(null);
      return;
    }
    input.focus();
    input.select();
    const cleanup = (): void => hide(mask);
    const resolveOk = (): void => {
      cleanup();
      resolve(input.value);
    };
    modal.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    modal.querySelector('[data-act="ok"]')?.addEventListener('click', resolveOk);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) {
        cleanup();
        resolve(null);
      }
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        resolveOk();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    });
  });
}

// 刷新工具栏激活态：光标所在处的标题/引用/列表/加粗等对应按钮高亮
function updateFormatBar(): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  const { schema, selection, storedMarks } = view.state;
  const $from = selection.$from;
  const textblock = $from.node($from.depth);

  const markActive = (type: MarkType): boolean => {
    if (selection.empty) {
      const marks = storedMarks ?? $from.marks();
      return marks.some((mark) => mark.type === type);
    }
    let active = false;
    view.state.doc.nodesBetween(selection.from, selection.to, (node) => {
      if (node.marks.some((mark) => mark.type === type)) active = true;
    });
    return active;
  };

  const ancestorActive = (type: NodeType): boolean => {
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type === type) return true;
    }
    return false;
  };

  const set = (action: string, active: boolean): void => {
    const button = document.querySelector<HTMLButtonElement>(`#format-bar button[data-fmt="${action}"]`);
    if (button) button.classList.toggle('active', active);
  };

  set('h1', textblock.type === schema.nodes.heading && textblock.attrs.level === 1);
  set('h2', textblock.type === schema.nodes.heading && textblock.attrs.level === 2);
  set('h3', textblock.type === schema.nodes.heading && textblock.attrs.level === 3);
  set('h4', textblock.type === schema.nodes.heading && textblock.attrs.level === 4);
  set('h5', textblock.type === schema.nodes.heading && textblock.attrs.level === 5);
  set('h6', textblock.type === schema.nodes.heading && textblock.attrs.level === 6);
  set('paragraph', textblock.type === schema.nodes.paragraph);
  set('codeblock', textblock.type === schema.nodes.code_block);
  set('bold', markActive(schema.marks.strong));
  set('italic', markActive(schema.marks.emphasis));
  set('strike', markActive(schema.marks.strike_through));
  set('code', markActive(schema.marks.inlineCode));
  set('quote', ancestorActive(schema.nodes.blockquote));
  set('ul', ancestorActive(schema.nodes.bullet_list));
  set('ol', ancestorActive(schema.nodes.ordered_list));
  set('indent', textblock.type === schema.nodes.paragraph && !!textblock.attrs.indent);
  set('dropcap', textblock.type === schema.nodes.paragraph && !!textblock.attrs.dropcap);
  const fsPx = activeFontSizePx(view);
  const fsButton = document.querySelector<HTMLButtonElement>('#format-bar button[data-fmt="fontsize"]');
  if (fsButton) {
    fsButton.textContent = fsPx ? '字号 ' + fsPx : '字号';
    fsButton.classList.toggle('active', !!fsPx);
  }
}

// 已在同类列表中则把列表项提升出来（取消列表），否则把当前块包进列表
function toggleList(view: EditorView, listType: NodeType, itemType: NodeType): boolean {
  const { selection } = view.state;
  const $from = selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === listType) {
      return liftListItem(itemType)(view.state, view.dispatch, view);
    }
  }
  return wrapInList(listType)(view.state, view.dispatch, view);
}

// 插入链接：有选中文字则给文字加链接，否则在光标处插入链接文字
async function insertLink(view: EditorView): Promise<boolean> {
  const { schema, selection } = view.state;
  const url = await promptModal('插入链接', 'https://example.com');
  if (!url || url.trim() === '') return false;
  const href = url.trim();
  if (selection.empty) {
    const node = schema.text(href, [schema.marks.link.create({ href, title: href })]);
    const tr = view.state.tr.insert(selection.from, node).scrollIntoView();
    view.dispatch(tr);
    return true;
  }
  return toggleMark(schema.marks.link, { href, title: href })(view.state, view.dispatch, view);
}

// 切换段落排版：首行缩进 / 首字下沉（选中多个段落时全部应用同一状态）
function toggleParagraphStyle(style: 'indent' | 'dropcap'): boolean {
  if (!state.editor) return false;
  const view = getEditorView(state.editor);
  view.focus();
  const { schema, selection } = view.state;
  const $from = selection.$from;
  const cursorPara = $from.node($from.depth);
  if (!cursorPara || cursorPara.type !== schema.nodes.paragraph) return false;
  const enable = !cursorPara.attrs[style];
  const tr = view.state.tr;
  const seen = new Set<number>();
  view.state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type === schema.nodes.paragraph && !seen.has(pos)) {
      seen.add(pos);
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, [style]: enable });
    }
  });
  if (tr.docChanged) view.dispatch(tr);
  return tr.docChanged;
}

// 宸ュ叿鏍?浠ｇ爜鍧? 鎸夐€夊尯鏁村潡鍚堝苟涓轰竴涓唬鐮佸潡锛岄伩鍏嶆妸閭绘帴娈佃惤/绌烘鍚﹀彉鎴愬绔嬩唬鐮佸潡
function applyCodeBlockCommand(view: EditorView): boolean {
  const { schema, selection } = view.state;
  const doc = view.state.doc;
  let fromPos: number;
  let toPos: number;
  if (selection instanceof AllSelection) {
    fromPos = 0;
    toPos = doc.content.size;
  } else if (selection instanceof NodeSelection) {
    fromPos = selection.from;
    toPos = selection.to;
  } else {
    fromPos = selection.$from.depth > 0 ? selection.$from.before() : selection.from;
    toPos = selection.$to.depth > 0 ? selection.$to.after() : selection.to;
  }
  let textblocks = 0;
  let hasNonCode = false;
  doc.nodesBetween(fromPos, toPos, (node) => {
    if (node.isTextblock) {
      textblocks++;
      if (node.type !== schema.nodes.code_block) hasNonCode = true;
    }
  });
  if (textblocks === 0) {
    // 空文档或光标不在文本块上：直接插入一个空代码块
    const node = schema.nodes.code_block.create(null, schema.text(''));
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  }
  // 宸茬粡鏄崟涓?浠ｇ爜鍧? 锛堝厜鏍囨垨鍏ㄩ€?锛?鏃犻渶澶勭悊
  if (textblocks === 1 && !hasNonCode) return false;
  const text = doc.textBetween(fromPos, toPos, '\n', '\n').replace(/\n+$/, '');
  const node = schema.nodes.code_block.create(null, schema.text(text));
  try {
    const tr = view.state.tr.replaceWith(fromPos, toPos, node);
    const cursor = tr.mapping.map(fromPos) + 1 + text.length;
    tr.setSelection(TextSelection.create(tr.doc, cursor));
    view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

// 上标/下标：选中文本后转成 Unicode 纯文本（x²、log₂），跨端渲染、往返无损
const SUPER_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ',
  m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};
const SUB_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
  s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

function convertScript(view: EditorView, kind: 'sup' | 'sub'): boolean {
  const { selection } = view.state;
  if (selection.empty) return false;
  const map = kind === 'sup' ? SUPER_MAP : SUB_MAP;
  const text = view.state.doc.textBetween(selection.from, selection.to, '', '');
  let converted = '';
  for (const ch of text) converted += map[ch] ?? ch;
  if (converted === text) return false;
  const tr = view.state.tr.insertText(converted, selection.from, selection.to);
  view.dispatch(tr);
  return true;
}

const MATH_SYMBOLS = [
  '∑', '∫', '√', 'π', '∞', '±', '÷', '×', '≠', '≈', '≤', '≥',
  '°', '∠', '⊥', '∥', '∈', '∉', '∀', '∃', '→', '←', '↑', '↓',
  '⇒', '⇔', 'α', 'β', 'γ', 'θ', 'λ', 'μ', 'σ', 'ω', 'Δ', '∇',
  '∂', '·', '∴', '∵', '%', '‰', '≡', '∝', '¬', '∧', '∨',
];

let mathPop: HTMLDivElement | null = null;
let mathPopOpen = false;
function onMathPopDocMouseDown(e: MouseEvent): void {
  if (!mathPopOpen) return;
  const target = e.target as HTMLElement | null;
  if (target && mathPop && mathPop.contains(target)) return;
  if (target && target.closest && target.closest('button[data-fmt="math"]')) return;
  closeMathPop();
}
function onMathPopKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMathPop();
}
function closeMathPop(): void {
  if (!mathPopOpen) return;
  mathPopOpen = false;
  if (mathPop) mathPop.remove();
  mathPop = null;
  document.removeEventListener('mousedown', onMathPopDocMouseDown);
  document.removeEventListener('keydown', onMathPopKeyDown);
}
function toggleMathPop(view: EditorView, anchor?: HTMLElement): boolean {
  if (mathPopOpen) {
    closeMathPop();
    return false;
  }
  const pop = document.createElement('div');
  pop.className = 'mm-math-pop';
  for (const sym of MATH_SYMBOLS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mm-math-item';
    item.textContent = sym;
    item.addEventListener('click', () => {
      view.dispatch(view.state.tr.insertText(sym));
      closeMathPop();
      view.focus();
    });
    pop.appendChild(item);
  }
  document.body.appendChild(pop);
  mathPop = pop;
  mathPopOpen = true;
  document.addEventListener('mousedown', onMathPopDocMouseDown);
  document.addEventListener('keydown', onMathPopKeyDown);
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const cols = 8;
    const estWidth = cols * 34 + (cols - 1) * 4 + 12;
    const estHeight = Math.ceil(pop.children.length / cols) * 30 + 12;
    let left = rect.left;
    if (left + estWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - estWidth - 8);
    let top = rect.bottom + 4;
    if (top + estHeight > window.innerHeight - 8) top = Math.max(8, rect.top - estHeight - 4);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  return true;
}

const FONT_SIZES = ['12', '14', '16', '18', '20', '24', '28', '32', '36'];

// 字号：有选区时对选中文字局部设置（mark，标题等文本块同样生效）；无选区且光标在段落时沿用段落级；再点当前字号或“默认”恢复
function activeFontSizePx(view: EditorView): string {
  const { selection, storedMarks } = view.state;
  const find = (marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[]): string => {
    const fs = marks.find((mk) => mk.type.name === 'fontSize');
    return fs ? String(fs.attrs.px ?? '') : '';
  };
  if (selection.empty) {
    const fromMark = find(storedMarks ?? selection.$from.marks());
    if (fromMark) return fromMark;
    const para = selection.$from.node(selection.$from.depth);
    if (para && para.type.name === 'paragraph') return String(para.attrs.fontSize ?? '');
    return '';
  }
  let px = '';
  view.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!px && node.marks.length) {
      const fs = node.marks.find((mk) => mk.type.name === 'fontSize');
      if (fs) px = String(fs.attrs.px ?? '');
    }
  });
  return px;
}

function applyFontSize(view: EditorView, px: string): boolean {
  const { schema, selection } = view.state;
  const fontSizeMark = (schema.marks as unknown as { fontSize: MarkType }).fontSize;
  if (!fontSizeMark) return false;
  if (!selection.empty) {
    return toggleMark(fontSizeMark, px ? { px } : null)(view.state, view.dispatch, view);
  }
  const $from = selection.$from;
  const cursorPara = $from.node($from.depth);
  if (cursorPara && cursorPara.type === schema.nodes.paragraph) {
    const target = String(cursorPara.attrs.fontSize ?? '') === px ? '' : px;
    const tr = view.state.tr;
    const seen = new Set<number>();
    view.state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type === schema.nodes.paragraph && !seen.has(pos)) {
        seen.add(pos);
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, fontSize: target });
      }
    });
    if (tr.docChanged) view.dispatch(tr);
    return tr.docChanged;
  }
  return toggleMark(fontSizeMark, px ? { px } : null)(view.state, view.dispatch, view);
}

let fontSizePop: HTMLDivElement | null = null;
let fontSizePopOpen = false;
function onFsPopDocMouseDown(e: MouseEvent): void {
  if (!fontSizePopOpen) return;
  const target = e.target as HTMLElement | null;
  if (target && fontSizePop && fontSizePop.contains(target)) return;
  if (target && target.closest && target.closest('button[data-fmt="fontsize"]')) return;
  closeFontSizePop();
}
function onFsPopKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeFontSizePop();
}
function closeFontSizePop(): void {
  if (!fontSizePopOpen) return;
  fontSizePopOpen = false;
  if (fontSizePop) fontSizePop.remove();
  fontSizePop = null;
  document.removeEventListener('mousedown', onFsPopDocMouseDown);
  document.removeEventListener('keydown', onFsPopKeyDown);
}
function toggleFontSizePop(view: EditorView, anchor?: HTMLElement): boolean {
  if (fontSizePopOpen) {
    closeFontSizePop();
    return false;
  }
  const pop = document.createElement('div');
  pop.className = 'mm-fs-pop';
  const current = activeFontSizePx(view);
  const addItem = (label: string, px: string): void => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mm-fs-item';
    item.textContent = label;
    if (current === px) item.classList.add('active');
    item.addEventListener('click', () => {
      applyFontSize(view, px);
      closeFontSizePop();
      view.focus();
    });
    pop.appendChild(item);
  };
  addItem('默认', '');
  for (const px of FONT_SIZES) addItem(px + 'px', px);
  document.body.appendChild(pop);
  fontSizePop = pop;
  fontSizePopOpen = true;
  document.addEventListener('mousedown', onFsPopDocMouseDown);
  document.addEventListener('keydown', onFsPopKeyDown);
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const estWidth = 120;
    const estHeight = (FONT_SIZES.length + 1) * 28 + 10;
    let left = rect.left;
    if (left + estWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - estWidth - 8);
    let top = rect.bottom + 4;
    if (top + estHeight > window.innerHeight - 8) top = Math.max(8, rect.top - estHeight - 4);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  return true;
}
const TABLE_MAX_ROWS = 8;
const TABLE_MAX_COLS = 8;
let tablePop: HTMLDivElement | null = null;
let tablePopOpen = false;
function onTablePopDocMouseDown(e: MouseEvent): void {
  if (!tablePopOpen) return;
  const target = e.target as HTMLElement | null;
  if (target && tablePop && tablePop.contains(target)) return;
  if (target && target.closest && target.closest('button[data-fmt="table"]')) return;
  closeTablePop();
}
function onTablePopKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeTablePop();
}
function closeTablePop(): void {
  if (!tablePopOpen) return;
  tablePopOpen = false;
  if (tablePop) tablePop.remove();
  tablePop = null;
  document.removeEventListener('mousedown', onTablePopDocMouseDown);
  document.removeEventListener('keydown', onTablePopKeyDown);
}
function toggleTablePop(view: EditorView, anchor?: HTMLElement): boolean {
  if (tablePopOpen) {
    closeTablePop();
    return false;
  }
  const pop = document.createElement('div');
  pop.className = 'mm-table-pop';
  const label = document.createElement('div');
  label.className = 'mm-table-pop-label';
  label.textContent = '3 × 3';
  pop.appendChild(label);
  const grid = document.createElement('div');
  grid.className = 'mm-table-grid';
  const cells: HTMLButtonElement[][] = [];
  const updateHover = (r: number, c: number): void => {
    label.textContent = `${r + 1} × ${c + 1}`;
    for (let i = 0; i < TABLE_MAX_ROWS; i++) {
      for (let j = 0; j < TABLE_MAX_COLS; j++) {
        cells[i][j].classList.toggle('hover', i <= r && j <= c);
      }
    }
  };
  for (let r = 0; r < TABLE_MAX_ROWS; r++) {
    const row: HTMLButtonElement[] = [];
    for (let c = 0; c < TABLE_MAX_COLS; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mm-table-cell';
      cell.addEventListener('mouseenter', () => updateHover(r, c));
      cell.addEventListener('click', () => {
        closeTablePop();
        view.focus();
        insertTableCommand.run({ row: r + 1, col: c + 1 });
        updateFormatBar();
      });
      grid.appendChild(cell);
      row.push(cell);
    }
    cells.push(row);
  }
  pop.appendChild(grid);
  document.body.appendChild(pop);
  tablePop = pop;
  tablePopOpen = true;
  document.addEventListener('mousedown', onTablePopDocMouseDown);
  document.addEventListener('keydown', onTablePopKeyDown);
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const cellSize = 24;
    const gap = 3;
    const estWidth = TABLE_MAX_COLS * cellSize + (TABLE_MAX_COLS - 1) * gap + 14;
    const estHeight = 26 + TABLE_MAX_ROWS * cellSize + (TABLE_MAX_ROWS - 1) * gap + 14;
    let left = rect.left;
    if (left + estWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - estWidth - 8);
    let top = rect.bottom + 4;
    if (top + estHeight > window.innerHeight - 8) top = Math.max(8, rect.top - estHeight - 4);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  return true;
}
async function runFormatCommand(action: string, source?: HTMLElement): Promise<void> {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  view.focus();
  const { schema } = view.state;
  const dispatch = view.dispatch;
  const ok = await (async () => {
    switch (action) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(action[1]);
        const { selection } = view.state;
        const node = selection.$from.node(selection.$from.depth);
        // 当前已是同级别标题：再次点击切换回正文
        if (node.type === schema.nodes.heading && node.attrs.level === level) {
          return setBlockType(schema.nodes.paragraph)(view.state, dispatch, view);
        }
        return setBlockType(schema.nodes.heading, { level })(view.state, dispatch, view);
      }
      case 'paragraph':
        return setBlockType(schema.nodes.paragraph)(view.state, dispatch, view);
      case 'bold':
        return toggleMark(schema.marks.strong)(view.state, dispatch, view);
      case 'italic':
        return toggleMark(schema.marks.emphasis)(view.state, dispatch, view);
      case 'strike':
        return toggleMark(schema.marks.strike_through)(view.state, dispatch, view);
      case 'code':
        return toggleMark(schema.marks.inlineCode)(view.state, dispatch, view);
      case 'quote': {
        const { selection } = view.state;
        const $from = selection.$from;
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type === schema.nodes.blockquote) {
            // 已在引用块内：提升出引用（取消引用）
            return lift(view.state, dispatch, view);
          }
        }
        return wrapIn(schema.nodes.blockquote)(view.state, dispatch, view);
      }
      case 'codeblock':
        return applyCodeBlockCommand(view);
      case 'ul':
        return toggleList(view, schema.nodes.bullet_list, schema.nodes.list_item);
      case 'ol':
        return toggleList(view, schema.nodes.ordered_list, schema.nodes.list_item);
      case 'hr': {
        const tr = view.state.tr.replaceSelectionWith(schema.nodes.hr.create()).scrollIntoView();
        view.dispatch(tr);
        return true;
      }
      case 'link':
        return await insertLink(view);
      case 'indent':
        return toggleParagraphStyle('indent');
      case 'dropcap':
        return toggleParagraphStyle('dropcap');
      case 'sup':
        return convertScript(view, 'sup');
      case 'sub':
        return convertScript(view, 'sub');
      case 'math':
        return toggleMathPop(view, source);
      case 'fontsize':
        return toggleFontSizePop(view, source);
      case 'table':
        return toggleTablePop(view, source);
      default:
        return false;
    }
  })();
  if (ok) updateFormatBar();
}

/* ---------- 大纲 ---------- */
let outlineRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let activeHeadingPos = -1;

interface HeadingInfo {
  level: number;
  text: string;
  pos: number;
}

function collectHeadings(doc: Node): HeadingInfo[] {
  const list: HeadingInfo[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      list.push({ level: Number(node.attrs.level ?? 1), text: node.textContent.trim(), pos });
    }
  });
  return list;
}

function currentHeadingPos(doc: Node, cursorPos: number): number {
  let best = -1;
  for (const h of collectHeadings(doc)) {
    if (h.pos <= cursorPos) best = h.pos;
    else break;
  }
  return best;
}

function renderOutline(): void {
  const panel = $('outline-panel');
  if (!state.editor) {
    panel.innerHTML = '';
    return;
  }
  const view = getEditorView(state.editor);
  const doc = view.state.doc;
  activeHeadingPos = currentHeadingPos(doc, view.state.selection.from);
  const headings = collectHeadings(doc);
  panel.innerHTML = '';
  if (headings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'outline-empty';
    empty.textContent = '当前文档没有标题\n使用 H1–H6 即可生成大纲';
    panel.appendChild(empty);
    return;
  }
  for (const h of headings) {
    const row = document.createElement('div');
    row.className = 'outline-item' + (h.pos === activeHeadingPos ? ' active' : '');
    row.style.paddingLeft = Math.max(4, (h.level - 1) * 16 + 4) + 'px';
    const label = document.createElement('span');
    label.className = 'outline-text';
    label.textContent = h.text || '标题 ' + h.level;
    row.appendChild(label);
    row.addEventListener('click', () => gotoHeading(h.pos));
    panel.appendChild(row);
  }
}

function gotoHeading(pos: number): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  const doc = view.state.doc;
  const target = Math.min(doc.content.size, pos + 1);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.near(doc.resolve(target))),
  );
  scrollEditorToRange(view, pos, target);
  view.focus();
  renderOutline();
}

function scheduleOutlineRefresh(): void {
  if (outlineRefreshTimer) clearTimeout(outlineRefreshTimer);
  outlineRefreshTimer = setTimeout(() => {
    outlineRefreshTimer = null;
    if ($('tab-outline').classList.contains('active')) renderOutline();
  }, 120);
}

function setSidebarTab(tab: 'files' | 'outline'): void {
  $('tab-files').classList.toggle('active', tab === 'files');
  $('tab-outline').classList.toggle('active', tab === 'outline');
  $('folder-header').classList.toggle('hidden', tab !== 'files');
  $('file-tree').classList.toggle('hidden', tab !== 'files');
  $('outline-panel').classList.toggle('hidden', tab !== 'outline');
  if (tab === 'outline') renderOutline();
}

/* ---------- 查找与替换 ---------- */
interface SearchState {
  query: string;
  matches: Array<{ from: number; to: number }>;
  current: number;
}
const searchState: SearchState = { query: '', matches: [], current: -1 };

function computeMatches(doc: Node, query: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  if (!query) return out;
  const lower = query.toLowerCase();
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      const text = node.text.toLowerCase();
      let idx = text.indexOf(lower);
      while (idx !== -1) {
        out.push({ from: pos + idx, to: pos + idx + query.length });
        idx = text.indexOf(lower, idx + query.length);
      }
    }
  });
  return out;
}

function updateFindUI(): void {
  const count = $('find-count');
  const total = searchState.matches.length;
  count.textContent = total === 0 ? '0/0' : searchState.current + 1 + '/' + total;
}

function scrollEditorToRange(view: EditorView, from: number, to: number): void {
  const wrap = $('editor-wrap');
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  if (!start || !end) return;
  const rect = wrap.getBoundingClientRect();
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  const margin = 12;
  if (top < rect.top + margin) {
    wrap.scrollTop += top - rect.top - margin;
  } else if (bottom > rect.bottom - margin) {
    wrap.scrollTop += bottom - rect.bottom + margin;
  }
}

function goToMatch(index: number): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  const n = searchState.matches.length;
  if (n === 0) return;
  searchState.current = ((index % n) + n) % n;
  const m = searchState.matches[searchState.current];
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
      .setMeta(searchKey, [m]),
  );
  scrollEditorToRange(view, m.from, m.to);
  updateFindUI();
}

function applySearch(query: string): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  const matches = computeMatches(view.state.doc, query);
  searchState.query = query;
  searchState.matches = matches;
  searchState.current = matches.length ? 0 : -1;
  if (matches.length) {
    goToMatch(0);
  } else {
    view.dispatch(view.state.tr.setMeta(searchKey, []));
    updateFindUI();
  }
}

function refreshSearchMatches(): void {
  const bar = $('find-bar');
  if (bar.classList.contains('hidden') || !state.editor) return;
  const view = getEditorView(state.editor);
  const matches = computeMatches(view.state.doc, searchState.query);
  const same =
    matches.length === searchState.matches.length &&
    matches.every((m, i) => {
      const prev = searchState.matches[i];
      return !!prev && prev.from === m.from && prev.to === m.to;
    });
  if (!same) {
    searchState.matches = matches;
    if (matches.length === 0) searchState.current = -1;
    else if (searchState.current >= matches.length) searchState.current = 0;
    const cur = searchState.current >= 0 ? [matches[searchState.current]] : [];
    view.dispatch(view.state.tr.setMeta(searchKey, cur));
    updateFindUI();
  }
}

function replaceCurrentMatch(): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  if (searchState.matches.length === 0) return;
  const replacement = ($('find-replace-input') as HTMLInputElement).value;
  const m = searchState.matches[searchState.current];
  view.dispatch(view.state.tr.insertText(replacement, m.from, m.to));
  goToMatch(searchState.current);
}

function replaceAllMatches(): void {
  if (!state.editor) return;
  const view = getEditorView(state.editor);
  const matches = searchState.matches;
  if (matches.length === 0) return;
  const replacement = ($('find-replace-input') as HTMLInputElement).value;
  let tr = view.state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    tr = tr.insertText(replacement, matches[i].from, matches[i].to);
  }
  view.dispatch(tr);
}

function openFindBar(showReplace = false): void {
  const bar = $('find-bar');
  bar.classList.remove('hidden');
  $('find-replace-row').classList.toggle('hidden', !showReplace);
  const input = $('find-input') as HTMLInputElement;
  input.focus();
  input.select();
  if (searchState.query) applySearch(searchState.query);
}

function closeFindBar(): void {
  $('find-bar').classList.add('hidden');
  if (state.editor) {
    const view = getEditorView(state.editor);
    view.dispatch(view.state.tr.setMeta(searchKey, []));
    view.focus();
  }
  searchState.matches = [];
  searchState.current = -1;
  updateFindUI();
}

function onGlobalKeyDown(e: KeyboardEvent): void {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFindBar(false);
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    openFindBar(true);
    return;
  }
  if (ctrl && e.key === ',') {
    e.preventDefault();
    openSettings();
    return;
  }
  const bar = $('find-bar');
  if (bar.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
    return;
  }
  if (e.key === 'F3' || (ctrl && e.key.toLowerCase() === 'g')) {
    e.preventDefault();
    goToMatch(searchState.current + (e.shiftKey ? -1 : 1));
  }
}

/* ---------- 设置面板 ---------- */

// 颜色设置未自定义时按主题返回默认色（与 settings.applySettingsToDom 一致）
function zebraDefaultA(s: AppSettings): string {
  return s.codeZebraColorA ?? (s.theme === 'dark' ? '#ffffff' : '#000000');
}
function zebraDefaultB(s: AppSettings): string {
  return s.codeZebraColorB ?? (s.theme === 'dark' ? '#2e3540' : '#f0eee8');
}
function tableDefaultA(s: AppSettings): string {
  return s.tableColorA ?? (s.theme === 'dark' ? '#262b35' : '#fbfaf7');
}
function tableDefaultB(s: AppSettings): string {
  return s.tableColorB ?? (s.theme === 'dark' ? '#2c3240' : '#e7e5de');
}

// 背景图片左右边缘渐变（按图片自身渲染宽度计算，跟随图片位置对齐，而非窗口边缘）
const BG_IMAGE_FADE = 0.1;
const bgImageSizeCache = new Map<string, { w: number; h: number }>();

function bgImageUrl(path: string | null): string | null {
  if (!path) return null;
  return 'app://bundle/fs/' + encodeURIComponent(path);
}

function loadBgImageSize(path: string | null): Promise<{ w: number; h: number } | null> {
  if (!path) return Promise.resolve(null);
  const cached = bgImageSizeCache.get(path);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const url = bgImageUrl(path);
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      bgImageSizeCache.set(path, size);
      resolve(size);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function applyBgMaskTo(el: HTMLElement, size: { w: number; h: number } | null, contW: number, contH: number): void {
  if (!size || size.w <= 0 || size.h <= 0 || contW <= 0 || contH <= 0) {
    el.style.removeProperty('--bg-mask');
    el.style.removeProperty('--bg-mask-size');
    return;
  }
  // 背景按高度铺满：渲染宽度 = 容器高度 × 宽高比
  const imgW = contH * (size.w / size.h);
  const pct = Math.round(BG_IMAGE_FADE * 100);
  el.style.setProperty('--bg-mask-size', imgW + 'px 100%');
  el.style.setProperty(
    '--bg-mask',
    'linear-gradient(to right, transparent 0%, #000 ' + pct + '%, #000 ' + (100 - pct) + '%, transparent 100%)',
  );
}

let bgMaskRaf = 0;
function applyBgImageMask(): void {
  cancelAnimationFrame(bgMaskRaf);
  bgMaskRaf = requestAnimationFrame(() => {
    void (async () => {
      const settings = getSettings();
      const size = await loadBgImageSize(settings.bgImage);
      const workspace = document.getElementById('workspace');
      if (workspace) applyBgMaskTo(workspace, size, workspace.clientWidth, workspace.clientHeight);
      const preview = document.querySelector<HTMLElement>('.bg-image-preview');
      if (preview) applyBgMaskTo(preview, size, preview.clientWidth, preview.clientHeight);
    })();
  });
}
function syncSettingsDom(): void {
  const settings = getSettings();
  applySettingsToDom(settings);
}

// 重置后把默认值刷新回设置面板控件
function syncSettingsForm(modal: HTMLElement, s: AppSettings): void {
  const setValue = (id: string, value: string): void => {
    const el = modal.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id);
    if (el) el.value = value;
  };
  const setChecked = (id: string, checked: boolean): void => {
    const el = modal.querySelector<HTMLInputElement>('#' + id);
    if (el) el.checked = checked;
  };
  const setText = (id: string, text: string): void => {
    const el = modal.querySelector('#' + id);
    if (el) el.textContent = text;
  };

  setValue('set-brightness', String(s.themeBrightness));
  setText('set-brightness-val', s.themeBrightness + '%');
  setValue('set-width', String(s.editorWidth));
  setText('set-width-val', s.editorWidth + '%');
  setValue('set-sidebar', String(s.sidebarWidth));
  setValue('set-body-font', String(s.defaultFontSize));
  setValue('set-bg-opacity', String(s.bgImageOpacity));
  setText('set-bg-opacity-val', s.bgImageOpacity + '%');
  const bgName = modal.querySelector('#bg-image-name');
  if (bgName) bgName.textContent = s.bgImage ? String(s.bgImage.split(/[\\/]/).pop()) : '未设置';
  const bgOpacityInput = modal.querySelector<HTMLInputElement>('#set-bg-opacity');
  const bgClearBtn = modal.querySelector<HTMLButtonElement>('#btn-clear-bg');
  if (bgOpacityInput) bgOpacityInput.disabled = !s.bgImage;
  if (bgClearBtn) bgClearBtn.disabled = !s.bgImage;
  setValue('set-bg-pos', s.bgImagePos);
  const bgPosSelect = modal.querySelector<HTMLSelectElement>('#set-bg-pos');
  if (bgPosSelect) bgPosSelect.disabled = !s.bgImage;
  setChecked('set-code-lines', s.codeLineNumbers);
  setValue('set-zebra', String(s.codeZebraOpacity));
  setText('set-zebra-val', s.codeZebraOpacity + '%');
  setValue('set-zebra-color-a', zebraDefaultA(s));
  setValue('set-zebra-color-b', zebraDefaultB(s));
  setValue('set-code-font', String(s.codeFontSize));
  setValue('set-table-color-a', tableDefaultA(s));
  setValue('set-table-color-b', tableDefaultB(s));
  setChecked('set-table-persist', s.tableSizePersist);
  setValue('set-image-mode', s.imageStoreMode);
  setValue('set-save-mode', s.saveMode);
  setValue('set-save-minutes', String(s.autoSaveMinutes));
  const minutesInput = modal.querySelector<HTMLInputElement>('#set-save-minutes');
  if (minutesInput) minutesInput.disabled = s.saveMode === 'manual';
}

let settingsBuilt = false;
let settingsPrev: 'welcome' | 'editor' = 'welcome';

function settingsViewHtml(): string {
  const s = getSettings();
  return `
    <div class="settings-layout">
      <aside class="settings-nav">
        <h2>设置</h2>
        <button type="button" class="settings-nav-item active" data-pane="appearance">外观</button>
        <button type="button" class="settings-nav-item" data-pane="codeblock">代码块</button>
        <button type="button" class="settings-nav-item" data-pane="table">表格</button>
        <button type="button" class="settings-nav-item" data-pane="image">图片</button>
        <button type="button" class="settings-nav-item" data-pane="save">保存</button>
        <button type="button" class="settings-nav-item" data-pane="theme">主题定制</button>
        <div class="settings-nav-foot">
          <button type="button" id="btn-settings-reset" class="btn btn-danger">重置全部设置</button>
          <button type="button" id="btn-settings-back" class="btn">← 返回</button>
        </div>
      </aside>
      <div class="settings-body">
        <section class="settings-pane" data-pane-body="appearance">
          <h3>外观<button type="button" class="btn-reset-group" data-group="appearance">重置</button></h3>

          <label class="settings-row">
            <span>编辑区占右侧宽度比例 <em id="set-width-val">${s.editorWidth}%</em></span>
            <input type="range" id="set-width" min="50" max="100" step="1" value="${s.editorWidth}" />
          </label>
          <label class="settings-row">
            <span>侧栏宽度（px）</span>
            <input type="number" id="set-sidebar" class="settings-number" min="160" max="800" value="${s.sidebarWidth}" />
          </label>
          <label class="settings-row">
            <span>默认字号（正文，不含标题）</span>
            <input type="number" id="set-body-font" class="settings-number" min="12" max="24" value="${s.defaultFontSize}" />
          </label>
          <div class="settings-row">
            <span>背景图片</span>
            <div class="bg-image-controls">
              <button type="button" id="btn-pick-bg" class="btn">选择图片</button>
              <button type="button" id="btn-clear-bg" class="btn" disabled>移除</button>
              <span id="bg-image-name" class="bg-image-name">未设置</span>
            </div>
          </div>
          <label class="settings-row">
            <span>背景透明度 <em id="set-bg-opacity-val">${s.bgImageOpacity}%</em></span>
            <input type="range" id="set-bg-opacity" min="0" max="100" step="1" value="${s.bgImageOpacity}" disabled />
          </label>
          <label class="settings-row">
            <span>背景图片位置</span>
            <select id="set-bg-pos" disabled>
              <option value="left">靠左</option>
              <option value="center">居中</option>
              <option value="right">靠右</option>
            </select>
          </label>
          <div class="bg-image-preview"></div>
        </section>
        <section class="settings-pane hidden" data-pane-body="codeblock">
          <h3>代码块<button type="button" class="btn-reset-group" data-group="codeblock">重置</button></h3>
          <label class="settings-row">
            <span>显示行号</span>
            <input type="checkbox" id="set-code-lines" ${s.codeLineNumbers ? 'checked' : ''} />
          </label>
          <label class="settings-row">
            <span>斑马纹透明度 <em id="set-zebra-val">${s.codeZebraOpacity}%</em></span>
            <input type="range" id="set-zebra" min="0" max="100" step="1" value="${s.codeZebraOpacity}" />
          </label>
          <label class="settings-row">
            <span>斑马纹颜色 A（奇数行）</span>
            <input type="color" id="set-zebra-color-a" value="${zebraDefaultA(s)}" />
          </label>
          <label class="settings-row">
            <span>斑马纹颜色 B（偶数行）</span>
            <input type="color" id="set-zebra-color-b" value="${zebraDefaultB(s)}" />
          </label>
          <label class="settings-row">
            <span>代码字号（px）</span>
            <input type="number" id="set-code-font" class="settings-number" min="10" max="24" value="${s.codeFontSize}" />
          </label>
          <div class="settings-demo">
            <div class="settings-demo-title">演示</div>
            <div class="demo-code">
              <div class="demo-code-head">
                <span class="demo-code-lang">python</span>
                <span class="demo-code-copy">复制</span>
              </div>
              <div class="demo-code-body">
                <div class="demo-code-line"><span class="tok-keyword">def</span> greet(name):</div>
                <div class="demo-code-line alt">&nbsp;&nbsp;&nbsp;&nbsp;<span class="tok-keyword">print</span>(<span class="tok-string">f"你好, {name}"</span>)</div>
                <div class="demo-code-line">greet(<span class="tok-string">"世界"</span>)</div>
                <div class="demo-code-line alt"><span class="tok-comment"># 这是一行注释</span></div>
              </div>
            </div>
          </div>
        </section>
        <section class="settings-pane hidden" data-pane-body="table">
          <h3>表格<button type="button" class="btn-reset-group" data-group="table">重置</button></h3>
          <label class="settings-row">
            <span>表格颜色 A</span>
            <input type="color" id="set-table-color-a" value="${tableDefaultA(s)}" />
          </label>
          <label class="settings-row">
            <span>表格颜色 B</span>
            <input type="color" id="set-table-color-b" value="${tableDefaultB(s)}" />
          </label>
          <label class="settings-row">
            <span>保存列宽/行高（写入 Markdown 源文件）</span>
            <input type="checkbox" id="set-table-persist" ${s.tableSizePersist ? "checked" : ""} />
          </label>
          <div class="settings-demo">
            <div class="settings-demo-title">演示</div>
            <table class="demo-table">
              <tbody>
                <tr><td>姓名</td><td>学科</td><td>成绩</td></tr>
                <tr><td>张三</td><td>语文</td><td>96</td></tr>
                <tr><td>李四</td><td>数学</td><td>88</td></tr>
                <tr><td>王五</td><td>英语</td><td>92</td></tr>
              </tbody>
            </table>
          </div>
        </section>
        <section class="settings-pane hidden" data-pane-body="image">
          <h3>图片<button type="button" class="btn-reset-group" data-group="image">重置</button></h3>
          <label class="settings-row">
            <span>图片保存路径</span>
            <select id="set-image-mode">
              <option value="assets">当前文件夹/assets/</option>
              <option value="file">同文件名 .assets/</option>
              <option value="same">当前文件夹</option>
            </select>
          </label>
        </section>
        <section class="settings-pane hidden" data-pane-body="save">
          <h3>保存<button type="button" class="btn-reset-group" data-group="save">重置</button></h3>
          <label class="settings-row">
            <span>保存方式</span>
            <select id="set-save-mode">
              <option value="auto">自动保存（每 N 分钟）</option>
              <option value="manual">手动保存（Ctrl+S）</option>
            </select>
          </label>
          <label class="settings-row">
            <span>自动保存间隔（分钟）</span>
            <input type="number" id="set-save-minutes" class="settings-number" min="1" max="60" value="${s.autoSaveMinutes}" />
          </label>
        </section>
        <section class="settings-pane hidden" data-pane-body="theme">
          <h3>主题定制</h3>
          <div class="theme-community-publish">
            <div class="theme-community-publish-info">
              <div class="theme-community-publish-title">发布主题到社区</div>
              <div class="theme-community-publish-desc">一键上传当前使用的主题到社区，分享给所有用户</div>
            </div>
            <div class="theme-community-actions">
              <button type="button" id="btn-community-open" class="btn btn-community">🌐 进入社区</button>
              <button type="button" id="btn-theme-community" class="btn btn-primary btn-community">🚀 发布到社区</button>
            </div>
          </div>
          <p class="settings-hint">整套界面 UI 都能换：色板、字体、代码配色、自定义 CSS。导出的 .mmtheme 文件可分享给其他用户，也是未来社区的标准格式。</p>
          <div class="theme-toolbar">
            <select id="theme-select" class="settings-select" title="主题列表"></select>
            <button type="button" id="btn-theme-apply" class="btn" title="应用当前编辑的主题">应用</button>
            <button type="button" id="btn-theme-save" class="btn" title="保存当前修改（内置主题需先复制）">保存</button>
            <button type="button" id="btn-theme-duplicate" class="btn" title="复制为新的主题">复制</button>
            <button type="button" id="btn-theme-new" class="btn" title="新建空主题">新建</button>
            <button type="button" id="btn-theme-delete" class="btn" title="删除当前主题（内置不可删）">删除</button>
            <button type="button" id="btn-theme-reset" class="btn" title="重置当前主题为基准默认（清除变量与自定义 CSS）">重置</button>
            <button type="button" id="btn-theme-help" class="btn" title="查看主题定制说明">说明</button>
            <span class="theme-toolbar-spacer"></span>
            <button type="button" id="btn-theme-export" class="btn" title="导出为 .mmtheme 文件">导出…</button>
            <button type="button" id="btn-theme-import" class="btn" title="从 .mmtheme 文件导入">导入…</button>
          </div>
          <div class="settings-row theme-meta-row">
            <span>主题名称</span>
            <input type="text" id="theme-name" class="settings-text" maxlength="50" />
            <span>基准</span>
            <select id="theme-base" class="settings-select">
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <label class="settings-row">
            <span>主题亮度 <em id="set-brightness-val">${s.themeBrightness}%</em></span>
            <input type="range" id="set-brightness" min="50" max="150" step="1" value="${s.themeBrightness}" />
          </label>
          <div id="theme-vars" class="theme-vars"></div>
          <div class="theme-css-block">
            <div class="theme-css-title">自定义 CSS<span>可覆盖任意细节，二次开发自由度</span></div>
            <textarea id="theme-custom-css" class="theme-css-input" spellcheck="false" placeholder="/* 例如：加大顶栏 */
.topbar { height: 56px; }"></textarea>
          </div>
          <div id="theme-help" class="theme-help hidden">
            <div class="theme-help-title">主题定制能改哪些 UI？</div>
            <ul class="theme-help-list">
              <li><b>基础色板</b>：全局背景、编辑区、侧栏、顶栏、主/次文字、边框、强调色、危险色、成功色</li>
              <li><b>背景与选中</b>：悬停、激活、选中项、失焦选中、弹窗背景</li>
              <li><b>浮层与提示</b>：遮罩、阴影、提示条、代码块头部</li>
              <li><b>编辑器内容</b>：代码块背景、行内代码、链接色、引用块边框</li>
              <li><b>代码语法</b>：字符串、数字、函数、属性</li>
              <li><b>查找高亮</b>：匹配背景、边框</li>
              <li><b>字体</b>：界面字体、代码字体</li>
            </ul>
            <div class="theme-help-title">自定义 CSS</div>
            <p>可写任意 CSS 覆盖任何 UI 细节：顶栏高度、圆角、间距、滚动条、右键菜单、大纲高亮等，二次开发自由度。</p>
            <div class="theme-help-title">不走主题的项（由设置页控制）</div>
            <p>代码块斑马纹/行号/代码字号、表格双色/列宽行高持久化、背景图/主题亮度、默认字号、编辑区宽度、侧栏宽度、图片路径、自动保存。</p>
          </div>
        </section>
      </div>
    </div>`;
}

function ensureThemeEditorSynced(): void {
  if (!settingsBuilt) return;
  refreshThemeSelect();
  loadThemeIntoEditor(getActiveTheme());
}

function switchSettingsPane(name: string): void {
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.pane === name);
  });
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    (pane as HTMLElement).classList.toggle('hidden', (pane as HTMLElement).dataset.paneBody !== name);
  });
}

function closeSettings(): void {
  hide($('settings-view'));
  if (settingsPrev === 'editor') showEditorArea();
  else showWelcome();
}

function openSettings(): void {
  const view = $('settings-view');
  if (!settingsBuilt) {
    view.innerHTML = settingsViewHtml();
    bindSettingsEvents();
    settingsBuilt = true;
  }
  settingsPrev = $('welcome').classList.contains('hidden') ? 'editor' : 'welcome';
  hide($('welcome'));
  hide($('editor-wrap'));
  show(view);
  refreshThemeSelect();
  loadThemeIntoEditor(getActiveTheme());
  switchSettingsPane('appearance');
  syncSettingsForm(view, getSettings());
  applyBgImageMask();
}

const THEME_SETTING_KEYS: ReadonlyArray<keyof AppSettings> = [
  'theme', 'themeBrightness', 'defaultFontSize',
  'bgImageOpacity', 'bgImagePos',
  'codeLineNumbers', 'codeZebraOpacity', 'codeZebraColorA', 'codeZebraColorB', 'codeFontSize',
  'tableColorA', 'tableColorB', 'tableSizePersist',
];

function collectThemeSettings(): Record<string, unknown> {
  const s = getSettings();
  const settings: Record<string, unknown> = {};
  for (const key of THEME_SETTING_KEYS) settings[key] = s[key];
  if (editedTheme) settings.theme = editedTheme.base;
  return settings;
}

interface ThemeVarItem { key: string; label: string; }

const THEME_VAR_GROUPS: Array<{ label: string; keys: ThemeVarItem[] }> = [
  { label: '基础色板', keys: [
    { key: '--bg', label: '全局背景' }, { key: '--bg-editor', label: '编辑区背景' },
    { key: '--bg-sidebar', label: '侧栏背景' }, { key: '--bg-topbar', label: '顶栏背景' },
    { key: '--text', label: '主文字' }, { key: '--text-dim', label: '次要文字' },
    { key: '--border', label: '边框' }, { key: '--accent', label: '强调色' },
    { key: '--accent-soft', label: '强调色浅底' }, { key: '--danger', label: '危险色' },
    { key: '--on-accent', label: '强调色上文字' }, { key: '--on-danger', label: '危险色上文字' },
    { key: '--success', label: '成功色' },
  ] },
  { label: '背景与选中', keys: [
    { key: '--bg-hover', label: '悬停背景' }, { key: '--bg-active', label: '激活背景' },
    { key: '--selection-bg', label: '选中项背景' }, { key: '--inactive-selection-bg', label: '失焦选中背景' },
    { key: '--modal-bg', label: '弹窗背景' },
  ] },
  { label: '浮层与提示', keys: [
    { key: '--mask', label: '遮罩' }, { key: '--shadow', label: '阴影' },
    { key: '--shadow-strong', label: '强阴影' }, { key: '--toast-bg', label: '提示条背景' },
    { key: '--toast-text', label: '提示条文字' }, { key: '--code-head-bg', label: '代码块头部背景' },
  ] },
  { label: '编辑器内容', keys: [
    { key: '--md-pre-bg', label: '代码块背景' }, { key: '--md-code-bg', label: '行内代码背景' },
    { key: '--md-code-text', label: '行内代码文字' }, { key: '--md-link', label: '链接色' },
    { key: '--md-blockquote-border', label: '引用块边框' },
  ] },
  { label: '代码语法高亮', keys: [
    { key: '--tok-string', label: '字符串' }, { key: '--tok-number', label: '数字' },
    { key: '--tok-func', label: '函数' }, { key: '--tok-attr', label: '属性' },
  ] },
  { label: '查找高亮', keys: [
    { key: '--highlight-bg', label: '高亮背景' }, { key: '--highlight-border', label: '高亮边框' },
  ] },
  { label: '字体', keys: [
    { key: '--font-ui', label: '界面字体' }, { key: '--font-code', label: '代码字体' },
  ] },
];

let editedTheme: ThemeDef | null = null;
let lastSyncedThemeId = '';

/** 把当前主题的背景图设置同步到全局 settings（外观面板与 DOM 共用） */
function syncThemeBgSettings(): void {
  const theme = getActiveTheme();
  saveSettings({
    bgImage: theme.bgImage,
    bgImageOpacity: theme.bgImageOpacity,
    bgImagePos: theme.bgImagePos,
    bgImageData: theme.bgImageData,
  });
}

/** 外观面板修改背景图时写回当前主题（内置主题也写，保证切换主题背景跟随） */
function setActiveThemeBg(patch: { bgImage?: string | null; bgImageData?: string | null; bgImageOpacity?: number; bgImagePos?: 'left' | 'center' | 'right' }): void {
  const theme = getActiveTheme();
  if (patch.bgImage !== undefined) theme.bgImage = patch.bgImage;
  if (patch.bgImageData !== undefined) theme.bgImageData = patch.bgImageData;
  if (patch.bgImageOpacity !== undefined) theme.bgImageOpacity = patch.bgImageOpacity;
  if (patch.bgImagePos !== undefined) theme.bgImagePos = patch.bgImagePos;
  saveTheme(theme);
  if (editedTheme && editedTheme.id === theme.id) {
    if (patch.bgImage !== undefined) editedTheme.bgImage = patch.bgImage;
    if (patch.bgImageData !== undefined) editedTheme.bgImageData = patch.bgImageData;
    if (patch.bgImageOpacity !== undefined) editedTheme.bgImageOpacity = patch.bgImageOpacity;
    if (patch.bgImagePos !== undefined) editedTheme.bgImagePos = patch.bgImagePos;
  }
}

function themeVarValue(key: string): string {
  if (editedTheme && editedTheme.variables[key]) return editedTheme.variables[key];
  return getComputedStyle(document.body).getPropertyValue(key).trim() || '';
}

function rgbToHex(rgb: string): string | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgb);
  if (!m) return null;
  return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
}

function hexToRgbaStr(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + alpha + ')';
}

function refreshThemeSelect(): void {
  const select = document.getElementById('theme-select') as HTMLSelectElement | null;
  if (!select) return;
  const themes = listThemes();
  const activeId = getActiveTheme().id;
  select.innerHTML = themes
    .map((t) => '<option value="' + t.id + '">' + escapeHtml(t.name) + (t.builtin ? '（内置）' : '') + '</option>')
    .join('');
  select.value = activeId;
}

let themeColorPicker: HTMLInputElement | null = null;
let themePickerTarget = '';

function ensureThemeColorPicker(): HTMLInputElement {
  if (themeColorPicker && document.contains(themeColorPicker)) return themeColorPicker;
  const input = document.createElement('input');
  input.type = 'color';
  input.id = 'theme-color-picker';
  input.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:99999;';
  document.body.appendChild(input);
  themeColorPicker = input;
  return input;
}

function safeCssColor(value: string): string {
  const t = value.trim();
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|transparent)$/.test(t)) return t;
  return 'transparent';
}

function renderThemeEditor(): void {
  const container = document.getElementById('theme-vars');
  if (!container || !editedTheme) return;
  const nameInput = document.getElementById('theme-name') as HTMLInputElement | null;
  const baseSelect = document.getElementById('theme-base') as HTMLSelectElement | null;
  const cssInput = document.getElementById('theme-custom-css') as HTMLTextAreaElement | null;
  if (nameInput) nameInput.value = editedTheme.name;
  if (baseSelect) baseSelect.value = editedTheme.base;
  if (cssInput) cssInput.value = editedTheme.customCss;
  container.innerHTML = THEME_VAR_GROUPS.map((group) => {
    const rows = group.keys.map((item) => {
      const current = themeVarValue(item.key);
      const isFont = item.key === '--font-ui' || item.key === '--font-code';
      const inputHtml = isFont
        ? '<input type="text" data-var="' + item.key + '" value="' + escapeHtml(current) + '" spellcheck="false" />'
        : '<div class="theme-var-input">' +
          '<input type="text" data-var="' + item.key + '" value="' + escapeHtml(current) + '" spellcheck="false" />' +
          '<button type="button" class="theme-var-swatch" data-var="' + item.key + '" title="点击选择颜色" style="--swatch-color: ' + safeCssColor(current) + '"></button>' +
          '</div>';
      return '<label class="theme-var-row"><span title="' + item.key + '">' + item.label + '</span>' + inputHtml + '</label>';
    }).join('');
    return '<div class="theme-var-group"><div class="theme-var-group-title">' + group.label + '</div>' + rows + '</div>';
  }).join('');
}

function loadThemeIntoEditor(theme: ThemeDef): void {
  editedTheme = { ...theme, variables: { ...theme.variables } };
  applyTheme(editedTheme);
  renderThemeEditor();
  const select = document.getElementById('theme-select') as HTMLSelectElement | null;
  if (select) select.value = theme.id;
  const saveBtn = document.getElementById('btn-theme-save') as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = theme.builtin;
}

function saveEditedTheme(): void {
  if (!editedTheme) return;
  if (editedTheme.builtin) {
    toast('内置主题不可直接修改，请先点「复制」再编辑');
    return;
  }
  const nameInput = document.getElementById('theme-name') as HTMLInputElement | null;
  const baseSelect = document.getElementById('theme-base') as HTMLSelectElement | null;
  const cssInput = document.getElementById('theme-custom-css') as HTMLTextAreaElement | null;
  if (nameInput && nameInput.value.trim()) editedTheme.name = nameInput.value.trim();
  if (baseSelect) editedTheme.base = baseSelect.value === 'dark' ? 'dark' : 'light';
  if (cssInput) editedTheme.customCss = cssInput.value;
  saveTheme(editedTheme);
  applyTheme(editedTheme);
  refreshThemeSelect();
  toast('主题已保存');
}

function applyEditedTheme(): void {
  if (!editedTheme) return;
  if (editedTheme.builtin) {
    activateTheme(editedTheme.id);
    saveSettings({ theme: editedTheme.base });
    syncThemeBgSettings();
    syncSettingsDom();
    toast('已应用主题：' + editedTheme.name);
    return;
  }
  saveEditedTheme();
  activateTheme(editedTheme.id);
  saveSettings({ theme: editedTheme.base });
  syncThemeBgSettings();
  syncSettingsDom();
  toast('已应用主题：' + editedTheme.name);
}

function newThemeFlow(): void {
  const base = getActiveTheme().base;
  const theme = createTheme('新主题', base);
  loadThemeIntoEditor(theme);
  refreshThemeSelect();
  activateTheme(theme.id);
  saveSettings({ theme: base });
  syncThemeBgSettings();
  toast('已创建新主题');
}

function duplicateThemeFlow(): void {
  if (!editedTheme) return;
  const theme = createTheme(editedTheme.name + ' 副本', editedTheme.base, editedTheme);
  loadThemeIntoEditor(theme);
  refreshThemeSelect();
  activateTheme(theme.id);
  saveSettings({ theme: theme.base });
  syncThemeBgSettings();
  toast('已复制主题');
}

function deleteThemeFlow(): void {
  if (!editedTheme) return;
  if (editedTheme.builtin) {
    toast('内置主题不可删除');
    return;
  }
  if (deleteTheme(editedTheme.id)) {
    const active = getActiveTheme();
    loadThemeIntoEditor(active);
    refreshThemeSelect();
    activateTheme(active.id);
    saveSettings({ theme: active.base });
    syncThemeBgSettings();
    toast('已删除主题');
  }
}

function selectThemeFlow(): void {
  const select = document.getElementById('theme-select') as HTMLSelectElement | null;
  if (!select) return;
  const theme = getTheme(select.value);
  if (!theme) return;
  loadThemeIntoEditor(theme);
  activateTheme(theme.id);
  saveSettings({ theme: theme.base });
  syncThemeBgSettings();
}

async function exportThemeFlow(): Promise<void> {
  try {
    if (!editedTheme) return;
    saveEditedTheme();
    const settings = collectThemeSettings();
    let bgImageBase64: string | null = null;
    const s = getSettings();
    if (s.bgImageData) {
      bgImageBase64 = s.bgImageData;
    } else if (s.bgImage) {
      const dataUrl = await window.api.readImageDataUrl(s.bgImage);
      if (dataUrl) {
        if (dataUrl.length > 8 * 1024 * 1024) {
          toast('背景图超过 8MB，导出时未包含背景图');
        } else {
          bgImageBase64 = dataUrl;
        }
      }
    }
    const result = await window.api.exportTheme({
      name: editedTheme.name,
      base: editedTheme.base,
      variables: editedTheme.variables,
      customCss: editedTheme.customCss,
      settings,
      bgImageBase64,
    });
    if (!result.canceled) {
      toast(result.filePath ? '主题已导出' : '导出失败');
    }
  } catch (error) {
    console.error('[theme:export]', error);
    toast('导出主题失败');
  }
}

async function importThemeFlow(): Promise<void> {
  try {
    const result = await window.api.importTheme();
    if (result.canceled) return;
    if (result.error || !result.settings) {
      toast(result.error ?? '导入失败');
      return;
    }
    const base = result.base === 'dark' ? 'dark' : 'light';
    const theme = createTheme(result.name ?? '导入的主题', base);
    theme.variables = { ...(result.variables ?? {}) };
    theme.customCss = result.customCss ?? '';
    const imported = (result.settings ?? {}) as Partial<AppSettings>;
    theme.bgImage = imported.bgImage ?? null;
    theme.bgImageOpacity = typeof imported.bgImageOpacity === 'number' ? imported.bgImageOpacity : 20;
    theme.bgImagePos = imported.bgImagePos === 'left' || imported.bgImagePos === 'right' ? imported.bgImagePos : 'center';
    theme.bgImageData = result.bgImageBase64 && result.bgImageBase64.length <= MAX_BG_DATA_LEN ? result.bgImageBase64 : null;
    saveTheme(theme);
    loadThemeIntoEditor(theme);
    refreshThemeSelect();
    activateTheme(theme.id);
    saveSettings({ ...imported, theme: base });
    syncThemeBgSettings();
    syncSettingsForm($('settings-view'), getSettings());
    syncSettingsDom();
    toast('已导入主题：' + theme.name);
  } catch (error) {
    console.error('[theme:import]', error);
    toast('导入主题失败');
  }
}

/* ---------- 社区一键发布 ---------- */

function communityLoginModal(saved: CommunityAuth | null): Promise<CommunityAuth | null> {
  return new Promise((resolve) => {
    const mask = $('modal-mask');
    const modal = $('modal');
    modal.classList.add('community-modal');
    modal.innerHTML = `
      <h3>登录社区账号</h3>
      <div class="community-form">
        <label>服务器地址
          <input id="c-login-url" class="inline-input" value="${escapeHtml(saved?.baseUrl ?? 'http://47.97.29.11:4000')}" placeholder="http://47.97.29.11:4000" spellcheck="false" />
        </label>
        <label>用户名
          <input id="c-login-user" class="inline-input" value="${escapeHtml(saved?.username ?? '')}" placeholder="社区用户名" spellcheck="false" />
        </label>
        <label>密码
          <input id="c-login-pass" class="inline-input" type="password" placeholder="${saved?.password ? '已保存，留空则沿用' : '社区密码'}" />
        </label>
        <p id="c-login-error" class="community-error hidden"></p>
        <p class="community-tip">登录信息仅保存在本机；社区默认地址为 http://47.97.29.11:4000。</p>
      </div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-primary" data-act="ok">登录并发布</button>
      </div>`;
    show(mask);
    const urlInput = modal.querySelector<HTMLInputElement>('#c-login-url');
    const userInput = modal.querySelector<HTMLInputElement>('#c-login-user');
    const passInput = modal.querySelector<HTMLInputElement>('#c-login-pass');
    const errorEl = modal.querySelector('#c-login-error');
    const okBtn = modal.querySelector<HTMLButtonElement>('[data-act="ok"]');
    if (!urlInput || !userInput || !passInput || !errorEl || !okBtn) {
      resolve(null);
      return;
    }
    urlInput.focus();
    const setError = (msg: string): void => {
      errorEl.textContent = msg;
      errorEl.classList.toggle('hidden', !msg);
    };
    const setBusy = (busy: boolean): void => {
      okBtn.disabled = busy;
      okBtn.textContent = busy ? '登录中…' : '登录并发布';
    };
    const cleanup = (): void => {
      modal.classList.remove('community-modal');
      hide(mask);
    };
    const doLogin = async (): Promise<void> => {
      const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
      const username = userInput.value.trim();
      const password = passInput.value || saved?.password || '';
      if (!baseUrl || !username) {
        setError('请填写服务器地址和用户名');
        return;
      }
      if (!password) {
        setError('请输入密码');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const result = await window.api.communityLogin({ baseUrl, username, password, token: '' });
        if (!result.ok || !result.token) {
          setError(result.error ?? '登录失败');
          return;
        }
        cleanup();
        resolve({ baseUrl, username, password, token: result.token });
      } catch (error) {
        setError('登录失败：' + ((error as Error).message || '未知错误'));
      } finally {
        setBusy(false);
      }
    };
    modal.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    okBtn.addEventListener('click', () => void doLogin());
    mask.addEventListener('click', (event) => {
      if (event.target === mask) {
        cleanup();
        resolve(null);
      }
    });
    for (const input of [urlInput, userInput, passInput]) {
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          void doLogin();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cleanup();
          resolve(null);
        }
      });
    }
  });
}

interface CommunityPublishSelection {
  name: string;
  description: string;
  logout: boolean;
}

function communityPublishModal(options: {
  auth: CommunityAuth;
  themeName: string;
}): Promise<CommunityPublishSelection | null> {
  return new Promise((resolve) => {
    const mask = $('modal-mask');
    const modal = $('modal');
    modal.classList.add('community-modal');
    modal.innerHTML = `
      <h3>发布主题到社区</h3>
      <div class="community-form">
        <p class="community-account">以 <b>${escapeHtml(options.auth.username)}</b> 发布
          <button class="btn-link" data-act="logout">退出登录</button>
        </p>
        <label>
          主题名称
          <input id="c-pub-theme-name" class="inline-input" value="${escapeHtml(options.themeName)}" maxlength="60" spellcheck="false" />
        </label>
        <label>
          主题简介
          <textarea id="c-pub-theme-desc" class="inline-input" rows="3" maxlength="500" placeholder="可选，介绍主题特点"></textarea>
        </label>
        <p class="community-tip">发布时将自动生成主题效果图，社区用户可一键导入使用。</p>
      </div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-primary" data-act="ok">发布</button>
      </div>`;
    show(mask);
    const themeNameInput = modal.querySelector<HTMLInputElement>('#c-pub-theme-name');
    const themeDescInput = modal.querySelector<HTMLTextAreaElement>('#c-pub-theme-desc');
    const cleanup = (): void => {
      modal.classList.remove('community-modal');
      hide(mask);
    };
    const resolveWith = (sel: CommunityPublishSelection | null): void => {
      cleanup();
      resolve(sel);
    };
    modal.querySelector('[data-act="cancel"]')?.addEventListener('click', () => resolveWith(null));
    modal.querySelector('[data-act="logout"]')?.addEventListener('click', () =>
      resolveWith({ name: '', description: '', logout: true }),
    );
    modal.querySelector('[data-act="ok"]')?.addEventListener('click', () => {
      resolveWith({
        name: themeNameInput?.value ?? '',
        description: themeDescInput?.value ?? '',
        logout: false,
      });
    });
    mask.addEventListener('click', (event) => {
      if (event.target === mask) resolveWith(null);
    });
    for (const input of [themeNameInput, themeDescInput]) {
      if (!input) continue;
      const keyTarget = input as HTMLInputElement;
      keyTarget.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          resolveWith(null);
        }
      });
    }
    themeNameInput?.focus();
  });
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** 解析 CSS 颜色字符串为 [r,g,b,a]（0-255），失败时返回 fallback */
function parseColorRgba(value: string | null | undefined, fallback: [number, number, number, number]): [number, number, number, number] {
  if (!value) return fallback;
  const v = value.trim();
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(v))) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16)];
  }
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(v))) {
    const a = m[4] !== undefined ? Math.round(Number(m[4]) * 255) : 255;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return fallback;
}

/** 按当前主题真实配色生成一张社区主题效果图（1360×850），版式与主题展示图模板一致 */
async function buildThemePreviewImage(themeName: string): Promise<{ name: string; data: string } | null> {
  const W = 1360;
  const H = 850;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const ui = (weight: number, size: number): string =>
    `${weight} ${size}px "Microsoft YaHei","Segoe UI","PingFang SC",sans-serif`;
  const mono = (size: number): string => `${size}px Consolas,"Courier New",monospace`;
  const measure = (text: string, font: string): number => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };

  const color = (key: string, fallback: string): string => themeVarValue(key).trim() || fallback;
  const rgbaOf = (key: string, fallback: [number, number, number, number]): [number, number, number, number] =>
    parseColorRgba(themeVarValue(key), fallback);

  const bg = color('--bg', '#0a0e18');
  const bgSidebar = color('--bg-sidebar', '#070b14');
  const bgTopbar = color('--bg-topbar', '#0c111d');
  const bgHover = color('--bg-hover', '#16203a');
  const bgActive = color('--bg-active', '#1c2a4a');
  const text = color('--text', '#e8edf7');
  const textDim = color('--text-dim', '#8fa0bf');
  const border = color('--border', '#2a3a5c');
  const accent = color('--accent', '#5b8def');
  const accentSoft = color('--accent-soft', '#14203a');
  const onAccent = color('--on-accent', '#eaf2ff');
  const mdLink = color('--md-link', '#7ba4f5');
  const success = color('--success', '#7bc48f');
  const codeBg = rgbaOf('--code-bg', [46, 53, 64, 204]);
  const selectionBg = rgbaOf('--selection-bg', [124, 155, 255, 77]);
  const codeHead = rgbaOf('--code-head-bg', [91, 141, 239, 26]);
  const tokString = color('--tok-string', '#8fd8e8');
  const tokNumber = color('--tok-number', '#e3c98a');
  const tokFunc = color('--tok-func', '#5d9cff');
  const tokAttr = color('--tok-attr', '#c792ea');

  const s = getSettings();
  const bgPos: 'left' | 'center' | 'right' = s.bgImagePos === 'left' || s.bgImagePos === 'right' ? s.bgImagePos : 'center';
  const bgOpacity = Math.min(100, Math.max(5, typeof s.bgImageOpacity === 'number' ? s.bgImageOpacity : 20));
  const posLabel = bgPos === 'left' ? '靠左' : bgPos === 'right' ? '靠右' : '居中';
  const baseLabel = (editedTheme ? editedTheme.base : 'dark') === 'light' ? '浅色' : '深色';
  const title = themeName.trim() || '未命名主题';

  let bgDataUrl: string | null = s.bgImageData ?? null;
  if (!bgDataUrl && s.bgImage) bgDataUrl = await window.api.readImageDataUrl(s.bgImage);
  const bgImage = bgDataUrl ? await loadImageDataUrl(bgDataUrl) : null;
  const hasBg = !!bgImage && bgImage.width > 0;

  // 背景：主题底色 + 背景图（按位置/透明度 + 左右边缘渐变，与真实界面 --bg-mask 一致）
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const bgRgb = parseColorRgba(bg, [10, 14, 24, 255]);
  let px = 0;
  if (hasBg && bgImage) {
    const dh = H;
    const dw = (bgImage.width * H) / bgImage.height;
    px = bgPos === 'left' ? 0 : bgPos === 'right' ? W - dw : (W - dw) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.globalAlpha = bgOpacity / 100;
    ctx.drawImage(bgImage, px, 0, dw, dh);
    ctx.restore();
    ctx.globalAlpha = 1;
    // 左右边缘渐变消失：宽度不足/超出时柔和过渡到主题底色（与真实界面相同）
    const fadeW = dw * BG_IMAGE_FADE;
    const bgFull = `rgba(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]}, 1)`;
    const bgNone = `rgba(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]}, 0)`;
    const fadeL = ctx.createLinearGradient(px, 0, px + fadeW, 0);
    fadeL.addColorStop(0, bgFull);
    fadeL.addColorStop(1, bgNone);
    ctx.fillStyle = fadeL;
    ctx.fillRect(px, 0, fadeW, H);
    const fadeR = ctx.createLinearGradient(px + dw - fadeW, 0, px + dw, 0);
    fadeR.addColorStop(0, bgNone);
    fadeR.addColorStop(1, bgFull);
    ctx.fillStyle = fadeR;
    ctx.fillRect(px + dw - fadeW, 0, fadeW, H);
  }

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // ---- 顶栏 ----
  const tbH = 50;
  ctx.fillStyle = bgTopbar;
  ctx.fillRect(0, 0, W, tbH);
  ctx.fillStyle = accent;
  ctx.fillRect(0, tbH - 3, W, 3);
  ctx.beginPath();
  ctx.roundRect(16, 15, 10, 10, 3);
  ctx.fill();
  ctx.fillStyle = text;
  ctx.font = ui(700, 15);
  ctx.fillText('MyMarkdown', 36, 12);
  ctx.fillStyle = textDim;
  ctx.font = ui(400, 12);
  ctx.fillText(title + ' 主题预览' + (hasBg ? `（背景图${posLabel} · ${bgOpacity}%）` : '（纯色主题）'), 165, 14);

  const labels = ['打开文件夹', '新建', '保存', '导出 ▾', '⚙️', '🌙 ' + title];
  const labelW = labels.map((lbl) => Math.round(measure(lbl, ui(400, 12)) + 20));
  const totalW = labelW.reduce((a, b) => a + b, 0) + 8 * (labelW.length - 1);
  let cx = W - 16 - totalW;
  for (let i = 0; i < labels.length; i++) {
    const primary = i === labels.length - 1;
    const w = labelW[i];
    ctx.fillStyle = primary ? accent : bgTopbar;
    ctx.beginPath();
    ctx.roundRect(cx, 8, w, 28, 6);
    ctx.fill();
    ctx.fillStyle = primary ? onAccent : text;
    ctx.font = ui(400, 12);
    ctx.fillText(labels[i], cx + (w - measure(labels[i], ui(400, 12))) / 2, 14);
    cx += w + 8;
  }

  // ---- 侧栏 ----
  const sbW = 264;
  // 顶部 tabs(38px) + 文件夹标题(38px) 不显示背景照片；下方列表区域透明，让背景透出（与真实界面一致）
  ctx.fillStyle = bgSidebar;
  ctx.fillRect(0, tbH, sbW, 76);
  ctx.fillStyle = border;
  ctx.fillRect(sbW, tbH, 1, H - tbH);
  ctx.fillStyle = accentSoft;
  ctx.fillRect(0, tbH, sbW, 38);
  ctx.fillStyle = accent;
  ctx.font = ui(700, 13);
  ctx.fillText('文件', 30, tbH + 10);
  ctx.fillStyle = textDim;
  ctx.font = ui(400, 13);
  ctx.fillText('大纲', 90, tbH + 10);
  ctx.fillStyle = border;
  ctx.fillRect(0, tbH + 38, sbW, 1);
  ctx.fillStyle = textDim;
  ctx.font = ui(400, 12);
  ctx.fillText('📁 MyMarkdown 文档', 14, tbH + 48);
  ctx.fillStyle = border;
  ctx.fillRect(0, tbH + 74, sbW, 1);
  const items = ['📄 欢迎.md', '📄 主题说明.md', '📄 使用手册.md', '📁 assets', '   └ 🖼 theme-bg', '📄 待办清单.md'];
  let y = tbH + 84;
  for (let i = 0; i < items.length; i++) {
    if (i === 1) {
      ctx.fillStyle = `rgba(${selectionBg[0]}, ${selectionBg[1]}, ${selectionBg[2]}, ${selectionBg[3] / 255})`;
      ctx.beginPath();
      ctx.roundRect(8, y - 4, sbW - 16, 24, 6);
      ctx.fill();
      ctx.fillStyle = accent;
    } else {
      ctx.fillStyle = text;
    }
    ctx.fillText(items[i], 16, y);
    y += 27;
  }

  // ---- 编辑器区 ----
  const ex = sbW + 60;
  const ew = W - sbW - 90;
  ctx.fillStyle = text;
  ctx.font = ui(700, 26);
  ctx.fillText(title + ' 主题', ex, 60);
  ctx.fillStyle = border;
  ctx.fillRect(ex, 100, ew, 1);
  y = 116;
  ctx.fillStyle = text;
  ctx.font = ui(400, 14);
  ctx.fillText('配色取自 ', ex, y);
  let x1 = ex + measure('配色取自 ', ui(400, 14));
  ctx.fillStyle = mdLink;
  ctx.font = ui(700, 14);
  ctx.fillText(title, x1, y);
  x1 += measure(title, ui(700, 14));
  ctx.fillStyle = text;
  ctx.font = ui(400, 14);
  ctx.fillText('：' + baseLabel + '基调 + 强调色点缀。', x1, y);
  y += 30;
  ctx.fillStyle = accentSoft;
  ctx.beginPath();
  ctx.roundRect(ex, y, ew, 40, 6);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(ex, y, 3, 40);
  ctx.fillStyle = textDim;
  ctx.font = ui(400, 13);
  ctx.fillText(hasBg ? `背景图已内嵌 · ${posLabel}显示 · 透明度 ${bgOpacity}%` : '纯色主题 · 未内嵌背景图', ex + 14, y + 11);
  y += 58;

  // ---- 配色方案表 ----
  ctx.fillStyle = text;
  ctx.font = ui(700, 18);
  ctx.fillText('配色方案', ex, y);
  y += 30;
  const rows: Array<[string, string]> = [
    ['全局背景', '--bg'],
    ['强调色', '--accent'],
    ['正文', '--text'],
    ['次要文字', '--text-dim'],
    ['警示/危险', '--danger'],
  ];
  const colw = [150, 190, 300];
  const thH = 26;
  for (let ri = 0; ri < rows.length; ri++) {
    const ry = y + ri * thH;
    const tableW = colw[0] + colw[1] + colw[2];
    ctx.fillStyle = ri === 0 ? accentSoft : ri % 2 === 1 ? bgHover : bgActive;
    ctx.fillRect(ex, ry, tableW, thH);
    const key = rows[ri][1];
    const raw = themeVarValue(key).trim();
    const cells = ri === 0 ? ['用途', '颜色', '色值'] : [rows[ri][0], rows[ri][0], raw];
    let cx2 = ex;
    for (let ci = 0; ci < 3; ci++) {
      ctx.font = ui(400, 12);
      if (ri > 0 && ci === 1) {
        const swatch = parseColorRgba(themeVarValue(key), [128, 128, 128, 255]);
        ctx.fillStyle = `rgba(${swatch[0]}, ${swatch[1]}, ${swatch[2]}, ${swatch[3] / 255})`;
        ctx.beginPath();
        ctx.roundRect(cx2 + 8, ry + 5, 16, 16, 3);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = text;
        ctx.fillText(cells[ci], cx2 + 30, ry + 5);
      } else {
        const cell = ci === 2 && ri > 0 && cells[ci].length > 30 ? cells[ci].slice(0, 29) + '…' : cells[ci];
        ctx.fillStyle = ri === 0 ? accent : text;
        ctx.fillText(cell, cx2 + 8, ry + 5);
      }
      cx2 += colw[ci];
    }
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(ex, ry, tableW, thH);
  }
  y += rows.length * thH + 22;

  // ---- 代码示例 ----
  ctx.fillStyle = text;
  ctx.font = ui(700, 18);
  ctx.fillText('代码示例', ex, y);
  y += 8;
  ctx.fillStyle = `rgba(${codeHead[0]}, ${codeHead[1]}, ${codeHead[2]}, ${codeHead[3] / 255})`;
  ctx.beginPath();
  ctx.roundRect(ex, y, ew, 26, 8);
  ctx.fill();
  ctx.fillStyle = textDim;
  ctx.font = ui(400, 12);
  ctx.fillText('TypeScript', ex + 12, y + 5);
  ctx.fillText('⧉ 复制', ex + ew - 70, y + 5);
  y += 26;
  ctx.fillStyle = `rgba(${codeBg[0]}, ${codeBg[1]}, ${codeBg[2]}, ${codeBg[3] / 255})`;
  ctx.beginPath();
  ctx.roundRect(ex, y, ew, 3 * 24 + 10, 8);
  ctx.fill();
  const segLines: Array<Array<[string, string]>> = [
    [['const ', tokNumber], ['theme', text], [' = ', text], ['"示例主题";', tokString]],
    [['const ', tokNumber], ['power', text], [' = ', text], ['99', tokNumber], [';', text]],
    [['function', tokFunc], [' demo', tokFunc], ['() { return { ', text], ['bgImagePos', tokAttr], [': ', text], ['"right"', tokString], [' }; }', text]],
  ];
  for (let li = 0; li < segLines.length; li++) {
    let cx2 = ex + 12;
    const ly = y + 6 + li * 24;
    for (const [seg, col] of segLines[li]) {
      ctx.fillStyle = col;
      ctx.fillText(seg, cx2, ly);
      cx2 += measure(seg, mono(13));
    }
  }
  y += 3 * 24 + 26;

  // ---- 链接示例 ----
  ctx.fillStyle = text;
  ctx.font = ui(400, 14);
  ctx.fillText('链接示例：', ex, y);
  x1 = ex + measure('链接示例：', ui(400, 14));
  const linkLabels = ['示例链接 A', '示例链接 B'];
  for (let i = 0; i < linkLabels.length; i++) {
    ctx.fillStyle = mdLink;
    ctx.fillText(linkLabels[i], x1, y);
    x1 += measure(linkLabels[i], ui(400, 14));
    if (i === 0) {
      ctx.fillStyle = textDim;
      const sep = ' · ';
      ctx.fillText(sep, x1, y);
      x1 += measure(sep, ui(400, 14));
    }
  }
  y += 34;

  // ---- 待办清单 ----
  const todos: Array<[string, boolean]> = [
    ['识别图片出处', true],
    ['提取主色并生成 .mmtheme', true],
    [`内嵌背景图 · ${posLabel} · ${bgOpacity}%`, hasBg],
    ['导入 MyMarkdown 验证效果', false],
  ];
  for (const [t, done] of todos) {
    ctx.strokeStyle = done ? success : textDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(ex + 2, y + 3, 12, 12, 3);
    ctx.stroke();
    if (done) {
      ctx.strokeStyle = success;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ex + 3, y + 9);
      ctx.lineTo(ex + 6, y + 12);
      ctx.lineTo(ex + 13, y + 4);
      ctx.stroke();
    }
    ctx.fillStyle = done ? text : textDim;
    ctx.font = ui(400, 13);
    ctx.fillText(t, ex + 22, y);
    y += 26;
  }

  const dataUrl = canvas.toDataURL('image/png');
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m || m[1].length === 0) return null;
  return { name: 'preview.png', data: m[1] };
}


async function buildThemePublishPayload(): Promise<{
  base: 'light' | 'dark';
  fileName: string;
  fileData: string;
  previewName: string | undefined;
  previewData: string | undefined;
} | null> {
  if (!editedTheme) return null;
  const nameInput = document.getElementById('theme-name') as HTMLInputElement | null;
  const baseSelect = document.getElementById('theme-base') as HTMLSelectElement | null;
  const cssInput = document.getElementById('theme-custom-css') as HTMLTextAreaElement | null;
  const name = (nameInput && nameInput.value.trim()) || editedTheme.name;
  const base = baseSelect ? (baseSelect.value === 'dark' ? 'dark' : 'light') : editedTheme.base;
  const customCss = cssInput ? cssInput.value : editedTheme.customCss;
  const settings = collectThemeSettings();
  settings.theme = base;
  let bgImageBase64: string | null = null;
  const s = getSettings();
  if (s.bgImageData) {
    bgImageBase64 = s.bgImageData;
  } else if (s.bgImage) {
    const dataUrl = await window.api.readImageDataUrl(s.bgImage);
    if (dataUrl && dataUrl.length <= 8 * 1024 * 1024) bgImageBase64 = dataUrl;
  }
  const themeJson = {
    format: 'mymarkdown-theme',
    version: 2,
    name,
    base,
    variables: editedTheme.variables,
    customCss,
    settings,
    bgImageBase64,
  };
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'MyMarkdown主题';
  const preview = await buildThemePreviewImage(name);
  return {
    base,
    fileName: safeName + '.mmtheme',
    fileData: utf8ToBase64(JSON.stringify(themeJson)),
    previewName: preview?.name,
    previewData: preview?.data,
  };
}

function communitySuccessModal(sharePath: string, baseUrl: string): Promise<'copy' | 'done'> {
  return new Promise((resolve) => {
    const mask = $('modal-mask');
    const modal = $('modal');
    const fullUrl = baseUrl + sharePath;
    modal.classList.add('community-modal');
    modal.innerHTML = `
      <h3>发布成功</h3>
      <div class="community-form">
        <p class="community-tip">已发布到社区，分享链接：</p>
        <p class="community-url">${escapeHtml(fullUrl)}</p>
      </div>
      <div class="modal-actions">
        <button class="btn" data-act="done">完成</button>
        <button class="btn btn-primary" data-act="copy">复制链接</button>
      </div>`;
    show(mask);
    const cleanup = (): void => {
      modal.classList.remove('community-modal');
      hide(mask);
    };
    modal.querySelector('[data-act="done"]')?.addEventListener('click', () => {
      cleanup();
      resolve('done');
    });
    modal.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(fullUrl);
        toast('链接已复制');
      } catch {
        toast('复制失败，请手动复制');
      }
      cleanup();
      resolve('copy');
    });
    mask.addEventListener('click', (event) => {
      if (event.target === mask) {
        cleanup();
        resolve('done');
      }
    });
  });
}

async function openCommunityBrowserFlow(): Promise<void> {
  try {
    const auth = await window.api.loadCommunityAuth();
    const baseUrl = auth?.baseUrl?.trim() || 'http://47.97.29.11:4000';
    await window.api.openCommunityBrowser(baseUrl);
  } catch (error) {
    console.error('[open-community]', error);
    toast('打开社区失败，请检查网络后重试');
  }
}

async function publishCommunityFlow(): Promise<void> {
  try {
    if (!editedTheme) {
      toast('请先在主题定制页选择要发布的主题');
      return;
    }
    let auth = await window.api.loadCommunityAuth();
    if (!auth) {
      auth = await communityLoginModal(null);
      if (!auth) return;
    } else if (!auth.token) {
      // 有账号但无有效 token：先静默登录刷新 token；失败再弹登录框（错误就地显示）
      const silent = await window.api.communityLogin(auth);
      if (silent.ok && silent.token) {
        auth = { ...auth, token: silent.token };
      } else {
        auth = await communityLoginModal(auth);
        if (!auth) return;
      }
    }
    const selection = await communityPublishModal({
      auth,
      themeName: editedTheme.name ?? '未命名主题',
    });
    if (!selection) return;
    if (selection.logout) {
      await window.api.clearCommunityAuth();
      toast('已退出社区账号');
      void publishCommunityFlow();
      return;
    }
    toast('正在发布…');
    const built = await buildThemePublishPayload();
    if (!built) {
      toast('发布失败：当前主题不可用');
      return;
    }
    const payload: CommunityPublishPayload = {
      type: 'theme',
      name: selection.name.trim() || built.fileName.replace(/\.mmtheme$/i, ''),
      description: selection.description.trim(),
      baseTheme: built.base,
      fileName: built.fileName,
      fileData: built.fileData,
      previewName: built.previewName,
      previewData: built.previewData,
    };
    const result = await window.api.publishToCommunity(auth, payload);
    if (!result.ok) {
      if (result.needLogin) {
        const reAuth = await communityLoginModal(auth);
        if (reAuth) void publishCommunityFlow();
      } else {
        toast('发布失败：' + (result.error ?? '未知错误'));
      }
      return;
    }
    const data = result.data ?? {};
    const sharePath =
      typeof data.shareUrl === 'string'
        ? data.shareUrl
        : typeof data.slug === 'string'
          ? '/themes/' + data.slug
          : '';
    toast('发布成功！');
    if (sharePath) {
      await communitySuccessModal(sharePath, auth.baseUrl);
    }
  } catch (error) {
    console.error('[community:publish]', error);
    toast('发布失败：' + ((error as Error).message || '未知错误'));
  }
}

function bindSettingsEvents(): void {
  $('theme-select')?.addEventListener('change', selectThemeFlow);
  $('btn-theme-apply')?.addEventListener('click', applyEditedTheme);
  $('btn-theme-save')?.addEventListener('click', saveEditedTheme);
  $('btn-theme-new')?.addEventListener('click', newThemeFlow);
  $('btn-theme-duplicate')?.addEventListener('click', duplicateThemeFlow);
  $('btn-theme-delete')?.addEventListener('click', deleteThemeFlow);
  $('btn-theme-help')?.addEventListener('click', () => {
    const panel = $('theme-help');
    if (panel) panel.classList.toggle('hidden');
  });
  $('btn-theme-reset')?.addEventListener('click', () => {
    if (!editedTheme) return;
    editedTheme.variables = {};
    editedTheme.customCss = '';
    saveTheme(editedTheme);
    applyTheme(editedTheme);
    renderThemeEditor();
    toast('已重置为基准默认');
  });
  $('btn-theme-export')?.addEventListener('click', () => {
    void exportThemeFlow();
  });
  $('btn-theme-import')?.addEventListener('click', () => {
    void importThemeFlow();
  });
  $('btn-community-open')?.addEventListener('click', () => {
    void openCommunityBrowserFlow();
  });
  $('btn-theme-community')?.addEventListener('click', () => {
    void publishCommunityFlow();
  });
  $('theme-name')?.addEventListener('input', () => {
    if (editedTheme) {
      const value = ($('theme-name') as HTMLInputElement).value.trim();
      if (value) editedTheme.name = value;
    }
  });
  $('theme-base')?.addEventListener('change', () => {
    if (editedTheme) {
      editedTheme.base = ($('theme-base') as HTMLSelectElement).value === 'dark' ? 'dark' : 'light';
      applyTheme(editedTheme);
      saveSettings({ theme: editedTheme.base });
    }
  });
  $('theme-custom-css')?.addEventListener('input', () => {
    if (editedTheme) {
      editedTheme.customCss = ($('theme-custom-css') as HTMLTextAreaElement).value;
      applyTheme(editedTheme);
    }
  });
  const themeVarsBox = document.getElementById('theme-vars');
  themeVarsBox?.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    const key = target.dataset.var;
    if (!key || !editedTheme) return;
    const value = target.value.trim();
    if (value) editedTheme.variables[key] = value;
    else delete editedTheme.variables[key];
    applyTheme(editedTheme);
    const swatch = themeVarsBox.querySelector('.theme-var-swatch[data-var="' + key + '"]') as HTMLElement | null;
    if (swatch) swatch.style.setProperty('--swatch-color', safeCssColor(value || themeVarValue(key)));
  });
  themeVarsBox?.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('.theme-var-swatch') as HTMLElement | null;
    if (!target || !editedTheme) return;
    const key = target.dataset.var;
    if (!key) return;
    const current = themeVarValue(key);
    const hex = rgbToHex(current) ?? current;
    const picker = ensureThemeColorPicker();
    themePickerTarget = key;
    picker.value = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#000000';
    picker.style.cssText = 'position:fixed;left:24px;top:24px;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:99999;';
    requestAnimationFrame(() => {
      picker.click();
    });
  });
  ensureThemeColorPicker().addEventListener('change', () => {
    const key = themePickerTarget;
    if (!key || !editedTheme || !themeColorPicker) return;
    const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(themeVarValue(key));
    editedTheme.variables[key] = rgba ? hexToRgbaStr(themeColorPicker.value, Number(rgba[4])) : themeColorPicker.value;
    applyTheme(editedTheme);
    renderThemeEditor();
  });
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsPane((btn as HTMLElement).dataset.pane ?? 'appearance'));
  });
  $('btn-settings-back').addEventListener('click', closeSettings);
  $('btn-settings-reset').addEventListener('click', () => {
    const keepThemeId = getActiveTheme().id;
    resetSettings();
    // 重置全部设置不影响主题：保留当前激活主题，不清除已导入的主题
    const keepTheme = getTheme(keepThemeId) ?? getActiveTheme();
    activateTheme(keepTheme.id);
    saveSettings({ theme: keepTheme.base });
    refreshThemeSelect();
    loadThemeIntoEditor(keepTheme);
    syncThemeBgSettings();
    syncSettingsForm($('settings-view'), getSettings());
    syncSettingsDom();
    toast('已重置全部设置');
  });
  document.querySelectorAll('.btn-reset-group').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = (btn as HTMLElement).dataset.group as SettingsGroup;
      resetSettingsGroup(group);
      if (group === 'appearance') {
        setActiveThemeBg({ bgImage: null, bgImageData: null, bgImageOpacity: 20, bgImagePos: 'center' });
        syncThemeBgSettings();
      }
      syncSettingsForm($('settings-view'), getSettings());
    });
  });
  const modal = $('settings-view');

  modal.querySelector('#set-brightness')?.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    const label = modal.querySelector('#set-brightness-val');
    if (label) label.textContent = value + '%';
    saveSettings({ themeBrightness: value });
  });
  modal.querySelector('#set-width')?.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    const label = modal.querySelector('#set-width-val');
    if (label) label.textContent = value + '%';
    saveSettings({ editorWidth: value });
  });
  modal.querySelector('#set-sidebar')?.addEventListener('change', (event) => {
    saveSettings({ sidebarWidth: Number((event.target as HTMLInputElement).value) });
  });
  modal.querySelector('#set-body-font')?.addEventListener('change', (event) => {
    saveSettings({ defaultFontSize: Number((event.target as HTMLInputElement).value) });
  });
  modal.querySelector('#btn-pick-bg')?.addEventListener('click', async () => {
    const picked = await window.api.openImage();
    if (picked) {
      let bgImageData: string | null = null;
      const data = await window.api.readImageDataUrl(picked);
      if (data && data.length <= MAX_BG_DATA_LEN) {
        bgImageData = data;
      } else if (data) {
        toast('背景图较大，仅保存路径；缓存文件被清理后无法自动恢复');
      }
      saveSettings({ bgImage: picked, bgImageData });
      setActiveThemeBg({ bgImage: picked, bgImageData });
      syncSettingsForm($('settings-view'), getSettings());
    }
  });
  modal.querySelector('#btn-clear-bg')?.addEventListener('click', () => {
    saveSettings({ bgImage: null, bgImageData: null });
    setActiveThemeBg({ bgImage: null, bgImageData: null });
    syncSettingsForm($('settings-view'), getSettings());
  });
  modal.querySelector('#set-bg-opacity')?.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    const label = modal.querySelector('#set-bg-opacity-val');
    if (label) label.textContent = value + '%';
    saveSettings({ bgImageOpacity: value });
    setActiveThemeBg({ bgImageOpacity: value });
  });
  modal.querySelector('#set-bg-pos')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    saveSettings({ bgImagePos: value === 'left' || value === 'right' ? value : 'center' });
    setActiveThemeBg({ bgImagePos: value === 'left' || value === 'right' ? value : 'center' });
  });
  modal.querySelector('#set-code-lines')?.addEventListener('change', (event) => {
    saveSettings({ codeLineNumbers: (event.target as HTMLInputElement).checked });
  });
  modal.querySelector('#set-zebra')?.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    const label = modal.querySelector('#set-zebra-val');
    if (label) label.textContent = value + '%';
    saveSettings({ codeZebraOpacity: value });
  });
  modal.querySelector('#set-zebra-color-a')?.addEventListener('input', (event) => {
    saveSettings({ codeZebraColorA: (event.target as HTMLInputElement).value });
  });
  modal.querySelector('#set-zebra-color-b')?.addEventListener('input', (event) => {
    saveSettings({ codeZebraColorB: (event.target as HTMLInputElement).value });
  });
  modal.querySelector('#set-code-font')?.addEventListener('change', (event) => {
    saveSettings({ codeFontSize: Number((event.target as HTMLInputElement).value) });
  });
  modal.querySelector('#set-table-color-a')?.addEventListener('input', (event) => {
    saveSettings({ tableColorA: (event.target as HTMLInputElement).value });
  });
  modal.querySelector('#set-table-color-b')?.addEventListener('input', (event) => {
    saveSettings({ tableColorB: (event.target as HTMLInputElement).value });
  });
  modal.querySelector('#set-table-persist')?.addEventListener('change', (event) => {
    saveSettings({ tableSizePersist: (event.target as HTMLInputElement).checked });
  });
  modal.querySelector('#set-image-mode')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    saveSettings({ imageStoreMode: value === 'same' || value === 'file' ? value : 'assets' });
  });
  modal.querySelector('#set-save-mode')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    const minutesInput = modal.querySelector<HTMLInputElement>('#set-save-minutes');
    if (minutesInput) minutesInput.disabled = value === 'manual';
    saveSettings({ saveMode: value === 'manual' ? 'manual' : 'auto' });
  });
  modal.querySelector('#set-save-minutes')?.addEventListener('change', (event) => {
    saveSettings({ autoSaveMinutes: Number((event.target as HTMLInputElement).value) });
  });
}

function bindEvents(): void {
  // 左侧列表拖拽调整宽度
  const sidebar = $('sidebar');
  const sidebarResizer = $('sidebar-resizer');
  const workspace = $('workspace');
  sidebarResizer.addEventListener('mousedown', (event) => {
    event.preventDefault();
    sidebarResizer.classList.add('dragging');
    document.body.classList.add('resizing-sidebar');
    const onMove = (moveEvent: MouseEvent) => {
      const rect = workspace.getBoundingClientRect();
      const width = Math.max(160, Math.min(moveEvent.clientX - rect.left, Math.floor(rect.width * 0.5)));
      sidebar.style.width = width + 'px';
      saveSettings({ sidebarWidth: width });
    };
    const onUp = () => {
      sidebarResizer.classList.remove('dragging');
      document.body.classList.remove('resizing-sidebar');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 格式工具栏：点击执行格式命令
  const formatBar = $('format-bar');
  formatBar.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-fmt]');
    if (!button) return;
    event.preventDefault();
    void runFormatCommand(button.dataset.fmt ?? '', button);
  });

  // 编辑器每次派发事务后刷新工具栏激活态（点击、输入、格式命令都会触发）
  if (state.editor) {
    const view = getEditorView(state.editor);
    const baseDispatch = view.dispatch;
    view.dispatch = (tr) => {
      baseDispatch(tr);
      updateFormatBar();
      scheduleOutlineRefresh();
      refreshSearchMatches();
    };
  }

  $('btn-open-folder').addEventListener('click', () => void openFolder());
  $('btn-welcome-open').addEventListener('click', () => void openFolder());
  $('btn-new-file').addEventListener('click', () => void newFileSmart());
  $('btn-save').addEventListener('click', () => void saveFile());

  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-community-open').addEventListener('click', () => void openCommunityBrowserFlow());
  $('tab-files').addEventListener('click', () => setSidebarTab('files'));
  $('tab-outline').addEventListener('click', () => setSidebarTab('outline'));
  document.addEventListener('keydown', onGlobalKeyDown);
  $('find-input').addEventListener('input', (event) => applySearch((event.target as HTMLInputElement).value));
  $('find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); goToMatch(searchState.current + (event.shiftKey ? -1 : 1)); } });
  $('find-replace-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); replaceCurrentMatch(); } });
  $('find-close').addEventListener('click', () => closeFindBar());
  $('find-next').addEventListener('click', () => goToMatch(searchState.current + 1));
  $('find-prev').addEventListener('click', () => goToMatch(searchState.current - 1));
  $('find-replace-toggle').addEventListener('click', () => { $('find-replace-row').classList.toggle('hidden'); const input = $('find-replace-input') as HTMLInputElement; if (!$('find-replace-row').classList.contains('hidden')) input.focus(); });
  $('find-replace-one').addEventListener('click', () => replaceCurrentMatch());
  $('find-replace-all').addEventListener('click', () => replaceAllMatches());

  const exportButton = $('btn-export');
  const exportMenu = $('export-menu');
  exportButton.addEventListener('click', (event) => {
    event.stopPropagation();
    exportMenu.classList.toggle('hidden');
  });
  exportMenu.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');
    if (!button) return;
    exportMenu.classList.add('hidden');
    void doExport(button.dataset.kind as 'md' | 'html-copy' | 'html-inline' | 'pdf');
  });

  document.addEventListener('click', (event) => {
    hideContextMenu();
    const menu = $('export-menu');
    if (!menu.classList.contains('hidden') && !(event.target as HTMLElement).closest('.export-group')) {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement;
    const menu = $('context-menu');
    if (!menu.classList.contains('hidden') && !target.closest('#context-menu') && !target.closest('#editor-wrap')) {
      hideContextMenu();
    }
    if (target.closest('#editor-wrap')) {
      event.preventDefault();
      const img = target.closest<HTMLImageElement>('img.mymarkdown-img-el');
      const cell = target.closest<HTMLElement>('td, th');
      const inTable = !!state.editor && !!cell && isInTable(getEditorView(state.editor).state);
      if (inTable) {
        const view = getEditorView(state.editor!);
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const sel = view.state.selection;
        const keepCellSel =
          sel instanceof CellSelection && coords !== null && coords.pos >= sel.from && coords.pos <= sel.to;
        if (coords && !keepCellSel) {
          const $pos = view.state.doc.resolve(coords.pos);
          for (let d = $pos.depth; d > 0; d--) {
            const nodeName = $pos.node(d).type.name;
            if (nodeName === 'table_cell' || nodeName === 'table_header') {
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, $pos.before(d) + 1)),
              );
              break;
            }
          }
        }
        showTableContextMenu(event.clientX, event.clientY);
      } else if (img) {
        selectEditorImage(img);
        showImageContextMenu(event.clientX, event.clientY);
      } else {
        showEditorContextMenu(target, event.clientX, event.clientY);
      }
    }
  });

  // 图片点击选中 + 右边缘拖拽缩放；点击编辑区空白时光标定位到最近位置
  $('editor').addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement;
    const img = target.closest<HTMLImageElement>('img.mymarkdown-img-el');
    if (!state.editor) return;
    if (!img) {
      clearSelectedImage();
      if (!target.closest('.ProseMirror')) {
        // 阻止浏览器默认行为（点击空白会清空选区导致光标消失）
        event.preventDefault();
        const view = getEditorView(state.editor);
        // 把点击坐标限制在编辑器根节点内，映射到点击处最近的行，避免跳到文档末尾（屏幕外）
        const rect = view.dom.getBoundingClientRect();
        const left = Math.max(rect.left + 1, Math.min(event.clientX, rect.right - 1));
        const top = Math.max(rect.top + 1, Math.min(event.clientY, rect.bottom - 1));
        const pos = view.posAtCoords({ left, top });
        const lastEnd = endOfLastContentBlock(view.state.doc);
        const targetPos = pos ? Math.min(pos.pos, lastEnd) : lastEnd;
        const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(targetPos)));
        tr.scrollIntoView();
        view.dispatch(tr);
        view.focus();
      }
      return;
    }
    const rect = img.getBoundingClientRect();
    if (event.clientX > rect.right - 14) {
      event.preventDefault();
      startImageResize(event, img);
      return;
    }
    selectEditorImage(img);
  });

  // 窗口尺寸变化后刷新编辑器布局与光标，避免内容靠左、光标消失
  window.addEventListener('resize', () => {
    applyBgImageMask();
    if (!state.editor) return;
    const editor = state.editor;
    requestAnimationFrame(() => {
      const view = getEditorView(editor);
      void view.dom.getBoundingClientRect();
      // 强制滚动容器重绘，让 caret 随新布局重新定位
      const wrap = document.querySelector<HTMLElement>('.editor-wrap');
      if (wrap) {
        const top = wrap.scrollTop;
        wrap.scrollTop = top + 1;
        wrap.scrollTop = top;
      }
      if (!view.hasFocus()) return;
      // 通过 PM 派发 selection 微移再恢复，强制编辑器重绘光标（Chromium 在窗口变化后可能把 caret 画在旧位置）
      const sel = view.state.selection;
      const doc = view.state.doc;
      const target = sel.from > 0 ? sel.from - 1 : Math.min(doc.content.size, sel.from + 1);
      if (target !== sel.from) {
        const moved = view.state.tr.setSelection(TextSelection.near(doc.resolve(target)));
        moved.scrollIntoView();
        view.dispatch(moved);
        requestAnimationFrame(() => {
          if (!state.editor) return;
          const v2 = getEditorView(state.editor);
          const restore = v2.state.tr.setSelection(TextSelection.near(v2.state.doc.resolve(sel.from)));
          restore.scrollIntoView();
          v2.dispatch(restore);
        });
      }
    });
  });

  window.addEventListener('blur', () => {
    document.body.classList.add('app-inactive');
    void flushSave();
  });
  window.addEventListener('focus', () => document.body.classList.remove('app-inactive'));

  // 粘贴 / 拖入图片：自动保存到当前文件夹并插入 ![](...) 引用
  document.addEventListener('paste', (event) => {
    if (!(event.target as HTMLElement).closest('#editor-wrap')) return;
    const files = imageFilesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void handleImageFiles(files);
  });
  document.addEventListener('dragover', (event) => {
    if (!(event.target as HTMLElement).closest('#editor-wrap')) return;
    const dt = event.dataTransfer;
    if (dt && dataTransferHasImage(dt)) {
      event.preventDefault();
      if (dt.dropEffect) dt.dropEffect = 'copy';
    }
  });
  document.addEventListener('drop', (event) => {
    if (!(event.target as HTMLElement).closest('#editor-wrap')) return;
    const files = imageFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void handleImageFiles(files);
  });

  window.api.onMenu((action) => {
    switch (action) {
      case 'new-file':
        void newFileSmart();
        break;
      case 'open-folder':
        void openFolder();
        break;
      case 'save':
        void saveFile();
        break;
      case 'export-md':
        void doExport('md');
        break;
      case 'export-html':
        void doExport('html-copy');
        break;
      case 'export-pdf':
        void doExport('pdf');
        break;
      case 'publish-community':
        void publishCommunityFlow();
        break;
      case 'import-theme':
        void importThemeFlow();
        break;
      case 'export-theme':
        void exportThemeFlow();
        break;
      case 'toggle-theme':
        toggleTheme();
        break;
    }
  });
}

async function init(): Promise<void> {
  if (getActiveTheme().base !== getSettings().theme) {
    activateTheme(getSettings().theme === 'dark' ? 'builtin-dark' : 'builtin-light');
  } else {
    applyTheme(getActiveTheme());
  }
  // 旧版背景迁移（一次性）：把现有背景继承给所有没有背景的主题，
  // 避免旧数据在切换主题时丢失（来源：全局设置，或任一已带背景的主题）
  if (!localStorage.getItem('mm-theme-bg-migrated')) {
    const initSettings = getSettings();
    let bgSrc: { bgImage: string; bgImageOpacity: number; bgImagePos: 'left' | 'center' | 'right' } | null = null;
    if (initSettings.bgImage) {
      bgSrc = { bgImage: initSettings.bgImage, bgImageOpacity: initSettings.bgImageOpacity, bgImagePos: initSettings.bgImagePos };
    } else {
      const anyWithBg = listThemes().find((t) => t.bgImage);
      if (anyWithBg) {
        bgSrc = { bgImage: anyWithBg.bgImage as string, bgImageOpacity: anyWithBg.bgImageOpacity, bgImagePos: anyWithBg.bgImagePos };
      }
    }
    if (bgSrc) {
      const activeTheme = getActiveTheme();
      if (!activeTheme.bgImage) {
        activeTheme.bgImage = bgSrc.bgImage;
        activeTheme.bgImageOpacity = bgSrc.bgImageOpacity;
        activeTheme.bgImagePos = bgSrc.bgImagePos;
        saveTheme(activeTheme);
      }
    }
    // 补齐内嵌背景字节：有路径但没字节的主题，从文件读一次 data URL
    for (const theme of listThemes()) {
      if (theme.bgImage && !theme.bgImageData) {
        const data = await window.api.readImageDataUrl(theme.bgImage);
        if (data && data.length <= MAX_BG_DATA_LEN) {
          theme.bgImageData = data;
          saveTheme(theme);
        }
      }
    }
    localStorage.setItem('mm-theme-bg-migrated', '1');
  }
  // 修正：清除内置浅色主题上被旧迁移复制来的背景（浅色主题应无背景，切换主题时背景跟随）
  if (!localStorage.getItem('mm-theme-bg-fix-light')) {
    const lightTheme = getTheme('builtin-light');
    const darkTheme = getTheme('builtin-dark');
    if (lightTheme && darkTheme && lightTheme.bgImage && lightTheme.bgImage === darkTheme.bgImage) {
      lightTheme.bgImage = null;
      lightTheme.bgImageData = null;
      saveTheme(lightTheme);
    }
    localStorage.setItem('mm-theme-bg-fix-light', '1');
  }
  syncThemeBgSettings();
  syncSettingsDom();
  syncAutoSave();
  applyBgImageMask();
  lastSyncedThemeId = getActiveTheme().id;
  subscribeSettings((s) => {
    if (getActiveTheme().base !== s.theme) {
      activateTheme(s.theme === 'dark' ? 'builtin-dark' : 'builtin-light');
    }
    if (getActiveTheme().id !== lastSyncedThemeId) {
      lastSyncedThemeId = getActiveTheme().id;
      if (settingsBuilt) {
        refreshThemeSelect();
        loadThemeIntoEditor(getActiveTheme());
      }
    }

    syncSettingsDom();
    syncAutoSave();
    applyBgImageMask();
  });
  state.editor = await createEditor($('editor'), { onMarkdownChange: handleMarkdownChange });
  bindEvents();
  updateFormatBar();
  const lastFolder = localStorage.getItem('lastFolder');
  if (osPendingOpen) {
    const path = osPendingOpen;
    osPendingOpen = null;
    try {
      const dir = dirname(path);
      if (dir) {
        await enqueueFolderOpen(dir, path);
        return;
      }
    } catch {
      // 目录打开失败，退回默认流程
    }
  }
  if (lastFolder) {
    try {
      await enqueueFolderOpen(lastFolder);
      return;
    } catch {
      localStorage.removeItem('lastFolder');
      localStorage.removeItem('lastFile');
    }
  }
  showWelcome();
  updateButtons();
  if (osPendingOpen) {
    const path = osPendingOpen;
    osPendingOpen = null;
    const dir = dirname(path);
    if (dir) await enqueueFolderOpen(dir, path);
  }
}

window.api.onOpenFile((path) => handleOsOpenFile(path));
void init();