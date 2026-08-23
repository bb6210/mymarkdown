/* ---------- 设置模块：统一持久化 ----------
 * 所有设置聚合到一个 localStorage 的 settings 对象里，
 * 旧版散落的键（theme / sidebarWidth / imageStoreMode）首次加载时自动迁移。
 */

import { MAX_BG_VIDEO_DATA_LEN } from '../shared/api';

export type ThemeMode = 'light' | 'dark';
export type ImageStoreMode = 'assets' | 'same' | 'file';
export type SaveMode = 'auto' | 'manual';

export interface AppSettings {
  theme: ThemeMode;
  /** 编辑区占右侧宽度百分比（默认 90） */
  editorWidth: number;
  /** 左侧列表宽度 px */
  sidebarWidth: number;
  /** 图片保存方式 */
  imageStoreMode: ImageStoreMode;
  /** 代码块行号开关 */
  codeLineNumbers: boolean;
  /** 代码块斑马纹透明度（0-100） */
  codeZebraOpacity: number;
  /** 代码块斑马纹行颜色（hex，null=按主题默认） */
  codeZebraColorA: string | null;
  /** 代码块基础行颜色（hex，null=按主题默认） */
  codeZebraColorB: string | null;
  /** 表格棋盘格颜色 A（hex，null=按主题默认） */
  tableColorA: string | null;
  /** 表格棋盘格颜色 B（hex，null=按主题默认） */
  tableColorB: string | null;
  /** 表格列宽/行高持久化（写入 Markdown 源文件，Typora 风格 HTML 表格） */
  tableSizePersist: boolean;
  /** 代码块字号 px */
  codeFontSize: number;
  /** 默认正文字号 px（不含标题） */
  defaultFontSize: number;
  /** 保存方式：自动（按分钟）或手动 */
  saveMode: SaveMode;
  /** 自动保存间隔（分钟） */
  autoSaveMinutes: number;
  /** 软件背景图片绝对路径（null=未设置） */
  bgImage: string | null;
  /** 软件背景图片透明度（0-100） */
  bgImageOpacity: number;
  /** 主题亮度（50-150，100=默认） */
  themeBrightness: number;
  /** 背景图片水平位置 */
  bgImagePos: 'left' | 'center' | 'right';
  /** 背景图字节（data URL），路径失效时兜底显示用 */
  bgImageData: string | null;
  /** 软件背景视频绝对路径（null=未设置） */
  bgVideo: string | null;
  /** 背景视频字节（data URL），路径失效时兜底 */
  bgVideoData: string | null;
}

const SETTINGS_KEY = 'settings';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  editorWidth: 90,
  sidebarWidth: 240,
  imageStoreMode: 'assets',
  codeLineNumbers: true,
  codeZebraOpacity: 8,
  codeZebraColorA: null,
  codeZebraColorB: null,
  tableColorA: null,
  tableColorB: null,
  tableSizePersist: true,
  codeFontSize: 15,
  defaultFontSize: 15,
  saveMode: 'auto',
  autoSaveMinutes: 5,
  bgImage: null,
  bgImageData: null,
  bgVideo: null,
  bgVideoData: null,
  bgImageOpacity: 20,
  themeBrightness: 100,
  bgImagePos: 'center',
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalizeHex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 'rgba(0, 0, 0, ' + alpha + ')';
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + alpha + ')';
}

function scaleColor(hex: string, factor: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((n & 255) * factor));
  return 'rgb(' + r + ', ' + g + ', ' + b + ')';
}

function scaleRgba(rgba: string, factor: number): string {
  const m = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba);
  if (!m) return rgba;
  const r = Math.min(255, Math.round(Number(m[1]) * factor));
  const g = Math.min(255, Math.round(Number(m[2]) * factor));
  const b = Math.min(255, Math.round(Number(m[3]) * factor));
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + m[4] + ')';
}

function normalizeSettings(raw: unknown): AppSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: obj.theme === 'dark' ? 'dark' : 'light',
    editorWidth: clampInt(obj.editorWidth, 50, 100, DEFAULT_SETTINGS.editorWidth),
    sidebarWidth: clampInt(obj.sidebarWidth, 160, 800, DEFAULT_SETTINGS.sidebarWidth),
    imageStoreMode:
      obj.imageStoreMode === 'same' || obj.imageStoreMode === 'file'
        ? obj.imageStoreMode
        : 'assets',
    codeLineNumbers: obj.codeLineNumbers === false ? false : true,
    codeZebraOpacity: clampInt(obj.codeZebraOpacity, 0, 100, DEFAULT_SETTINGS.codeZebraOpacity),
    codeZebraColorA: normalizeHex(obj.codeZebraColorA),
    codeZebraColorB: normalizeHex(obj.codeZebraColorB),
    tableColorA: normalizeHex(obj.tableColorA),
    tableColorB: normalizeHex(obj.tableColorB),
    tableSizePersist: obj.tableSizePersist === false ? false : true,
    codeFontSize: clampInt(obj.codeFontSize, 10, 24, DEFAULT_SETTINGS.codeFontSize),
    defaultFontSize: clampInt(obj.defaultFontSize, 12, 24, DEFAULT_SETTINGS.defaultFontSize),
    saveMode: obj.saveMode === 'manual' ? 'manual' : 'auto',
    autoSaveMinutes: clampInt(obj.autoSaveMinutes, 1, 60, DEFAULT_SETTINGS.autoSaveMinutes),
    bgImage: typeof obj.bgImage === 'string' && obj.bgImage.trim() ? obj.bgImage : null,
    bgImageData:
      typeof obj.bgImageData === 'string' && obj.bgImageData.startsWith('data:image/') ? obj.bgImageData : null,
    bgVideo: typeof obj.bgVideo === 'string' && obj.bgVideo.trim() ? obj.bgVideo : null,
    bgVideoData:
      typeof obj.bgVideoData === 'string' &&
      obj.bgVideoData.startsWith('data:video/') &&
      obj.bgVideoData.length <= MAX_BG_VIDEO_DATA_LEN
        ? obj.bgVideoData
        : null,
    bgImageOpacity: clampInt(obj.bgImageOpacity, 0, 100, DEFAULT_SETTINGS.bgImageOpacity),
    themeBrightness: clampInt(obj.themeBrightness, 50, 150, DEFAULT_SETTINGS.themeBrightness),
    bgImagePos: obj.bgImagePos === 'left' || obj.bgImagePos === 'right' ? obj.bgImagePos : 'center',
  };
}

let cached: AppSettings | null = null;
const listeners = new Set<(settings: AppSettings) => void>();

function persist(): void {
  if (!cached) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cached));
  } catch (error) {
    // localStorage 配额不足（多为超大内嵌视频/图片）：丢弃内嵌字节后重试，避免设置页打不开
    console.error('[settings] persist failed, dropping embedded media', error);
    if (cached.bgVideoData || cached.bgImageData) {
      cached.bgVideoData = null;
      cached.bgImageData = null;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(cached));
      } catch {
        /* ignore */
      }
    }
  }
}

// 迁移旧版单键存储，迁移后删除旧键
function migrateLegacy(): void {
  if (!cached) return;
  const legacyTheme = localStorage.getItem('theme');
  const legacySidebar = localStorage.getItem('sidebarWidth');
  const legacyImage = localStorage.getItem('imageStoreMode');
  if (!legacyTheme && !legacySidebar && !legacyImage) return;
  if (legacyTheme) cached.theme = legacyTheme === 'dark' ? 'dark' : 'light';
  if (legacySidebar) {
    cached.sidebarWidth = clampInt(Number(legacySidebar), 160, 800, cached.sidebarWidth);
  }
  if (legacyImage) {
    cached.imageStoreMode = legacyImage === 'same' || legacyImage === 'file' ? legacyImage : 'assets';
  }
  localStorage.removeItem('theme');
  localStorage.removeItem('sidebarWidth');
  localStorage.removeItem('imageStoreMode');
  persist();
}

export function getSettings(): AppSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(SETTINGS_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  cached = normalizeSettings(raw);
  migrateLegacy();
  return cached;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch });
  cached = next;
  persist();
  for (const cb of listeners) cb(next);
  return next;
}

export function subscribeSettings(cb: (settings: AppSettings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// 一键重置：恢复全部默认值并通知订阅者
export function resetSettings(): AppSettings {
  const next = normalizeSettings(null);
  cached = next;
  persist();
  for (const cb of listeners) cb(next);
  return next;
}

// 分组重置：仅恢复指定分组的字段为默认值（其他字段保持用户当前值）
export type SettingsGroup = 'appearance' | 'codeblock' | 'table' | 'image' | 'save';

const GROUP_KEYS: Record<SettingsGroup, (keyof AppSettings)[]> = {
  appearance: ['editorWidth', 'sidebarWidth', 'defaultFontSize', 'bgImage', 'bgImageData', 'bgVideo', 'bgVideoData', 'bgImageOpacity', 'bgImagePos'],
  codeblock: ['codeLineNumbers', 'codeZebraOpacity', 'codeZebraColorA', 'codeZebraColorB', 'codeFontSize'],
  table: ['tableColorA', 'tableColorB', 'tableSizePersist'],
  image: ['imageStoreMode'],
  save: ['saveMode', 'autoSaveMinutes'],
};

export function resetSettingsGroup(group: SettingsGroup): AppSettings {
  const patch: Partial<AppSettings> = {};
  for (const key of GROUP_KEYS[group]) {
    (patch as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
  }
  const next = normalizeSettings({ ...getSettings(), ...patch });
  cached = next;
  persist();
  for (const cb of listeners) cb(next);
  return next;
}

// 把设置应用到页面：主题、编辑区宽度、侧栏宽度、代码块行号/斑马纹/字号、正文字号
// 变量统一写到 body 行内样式：CSS 变量是继承属性，body.dark 里的同名变量会遮蔽
// 从 html 继承的值，导致深色主题下设置不生效，因此必须覆盖在最近的公共祖先上。
/** 背景视频层：与背景图共用透明度/位置/左右淡出遮罩（CSS 变量继承自 #workspace） */
// 背景视频不走 app://bundle/fs 自定义协议（媒体流的 Range 处理不可靠），
// 改为 IPC 读入文件字节生成 Blob URL，保证 H.264/webm 等可正常播放。
let bgVideoBlobUrl: string | null = null;
let bgVideoBlobKey = '';
function revokeBgVideoBlob(): void {
  if (bgVideoBlobUrl) {
    URL.revokeObjectURL(bgVideoBlobUrl);
    bgVideoBlobUrl = null;
  }
  bgVideoBlobKey = '';
}

let bgVideoLoading: Promise<string | null> | null = null;

/** 解析背景视频的可播放 URL：内嵌 data URL 或 Blob URL（按路径缓存 + 并发去重） */
export async function loadBgVideoSource(): Promise<string | null> {
  const s = getSettings();
  if (s.bgVideoData) {
    if (bgVideoBlobUrl) revokeBgVideoBlob();
    return s.bgVideoData;
  }
  if (!s.bgVideo) {
    if (bgVideoBlobUrl) revokeBgVideoBlob();
    return null;
  }
  if (bgVideoBlobUrl && bgVideoBlobKey === s.bgVideo) return bgVideoBlobUrl;
  // 并发去重：主背景 / 遮罩计算 / 设置预览可能同时调用，
  // 若各自读文件并 revoke，会把对方正在播放的 blob 提前失效（MEDIA_ELEMENT_ERROR: Format error）
  const videoPath = s.bgVideo;
  if (bgVideoLoading) return bgVideoLoading;
  bgVideoLoading = (async () => {
    try {
      const r = await window.api.readVideoFile(videoPath);
      if (!r || !r.data || r.data.byteLength === 0) {
        console.warn('[bg-video] readVideoFile empty/failed for', videoPath);
        return null;
      }
      // 加载期间设置可能已变更，丢弃过期结果
      const current = getSettings();
      if (current.bgVideo !== videoPath) return null;
      if (bgVideoBlobUrl && bgVideoBlobKey === videoPath) return bgVideoBlobUrl;
      revokeBgVideoBlob();
      const bytes = new Uint8Array(r.data);
      bgVideoBlobUrl = URL.createObjectURL(new Blob([bytes], { type: r.type }));
      bgVideoBlobKey = videoPath;
      return bgVideoBlobUrl;
    } catch (error) {
      console.error('[bg-video] readVideoFile failed', error);
      return null;
    } finally {
      bgVideoLoading = null;
    }
  })();
  return bgVideoLoading;
}

let bgVideoSyncSeq = 0;
async function syncBgVideo(settings: AppSettings): Promise<void> {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  const seq = ++bgVideoSyncSeq;
  const src = await loadBgVideoSource();
  if (seq !== bgVideoSyncSeq) return; // 设置已再次变更，丢弃过期结果
  let video = document.getElementById('theme-bg-video') as HTMLVideoElement | null;
  if (!src) {
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    return;
  }
  if (!video) {
    video = document.createElement('video');
    video.id = 'theme-bg-video';
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('disablepictureinpicture', '');
    video.addEventListener('error', () => {
      const code = video?.error?.code ?? -1;
      const name = settings.bgVideo ? String(settings.bgVideo.split(/[\\/]/).pop() || settings.bgVideo) : '背景视频';
      const hint =
        code === 4
          ? '视频格式/编码不受支持（错误码4），请转成 H.264 的 mp4 或 webm'
          : code === 2
            ? '视频读取失败（错误码2）：文件可能被移动、占用或过大'
            : code === 3
              ? '视频解码失败（错误码3）：编码不受支持，请转成 H.264 的 mp4'
              : code === 1
                ? '视频加载被中断（错误码1），请重试'
                : '视频加载失败（错误码' + code + '），请重试';
      console.warn('[bg-video] load error', code, video?.error?.message, src.slice(0, 120));
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '「' + name + '」' + hint }));
      video?.remove();
    });
    video.addEventListener('loadeddata', () => {
      console.log('[bg-video] loadeddata readyState=' + (video?.readyState ?? -1) + ' size=' + (video?.videoWidth ?? 0) + 'x' + (video?.videoHeight ?? 0));
    });
    workspace.appendChild(video);
  }
  if (video.getAttribute('src') !== src) {
    console.log('[bg-video] set src=', src.startsWith('data:') ? 'data:' + src.length + ' chars' : src);
    try {
      video.src = src;
    } catch (error) {
      console.error('[bg-video] failed to set src', error);
      video?.remove();
      return;
    }
  }
  if (!document.hidden && video.isConnected) {
    video.play().then(() => {
      console.log('[bg-video] playing ' + video.videoWidth + 'x' + video.videoHeight);
    }).catch((err) => {
      console.warn('[bg-video] play failed', (err as Error | undefined)?.name, (err as Error | undefined)?.message);
    });
  }
}

/** 窗口最小化/隐藏时暂停背景视频，恢复后继续播放 */
export function bindBgVideoVisibility(): void {
  document.addEventListener('visibilitychange', () => {
    const video = document.getElementById('theme-bg-video') as HTMLVideoElement | null;
    if (!video || !video.src) return;
    if (document.hidden) video.pause();
    else if (video.isConnected) void video.play().catch(() => undefined);
  });
}
export function applySettingsToDom(settings: AppSettings): void {
  const dark = settings.theme === 'dark';
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('no-code-lines', !settings.codeLineNumbers);
  const bodyStyle = document.body.style;
  bodyStyle.setProperty('--editor-width', settings.editorWidth + '%');
  bodyStyle.setProperty('--base-font-size', settings.defaultFontSize + 'px');
  bodyStyle.setProperty('--code-font-size', settings.codeFontSize + 'px');
  const alpha = Math.min(1, Math.max(0, settings.codeZebraOpacity / 100));
  const zebraA = settings.codeZebraColorA ?? (dark ? '#ffffff' : '#000000');
  const zebraB = settings.codeZebraColorB ?? (dark ? '#2e3540' : '#f0eee8');
  bodyStyle.setProperty('--code-line-alt', hexToRgba(zebraA, alpha));
  bodyStyle.setProperty('--code-line-base', hexToRgba(zebraB, alpha));
  const tableA = settings.tableColorA ?? (dark ? '#262b35' : '#fbfaf7');
  const tableB = settings.tableColorB ?? (dark ? '#2c3240' : '#e7e5de');
  bodyStyle.setProperty('--table-color-a', hexToRgba(tableA, 0.82));
  bodyStyle.setProperty('--table-color-b', hexToRgba(tableB, 0.82));
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.width = settings.sidebarWidth + 'px';
  const brightnessFactor = settings.themeBrightness / 100;
  const base = dark
    ? { bg: '#20242c', editor: '#262b35', sidebar: '#1a1e26', topbar: '#1f242e', hover: '#2c3240', active: '#37415a', border: '#333b49', modal: '#262b35', codeBg: 'rgba(46, 53, 64, 0.8)' }
    : { bg: '#f4f3ef', editor: '#fbfaf7', sidebar: '#efeee9', topbar: '#faf9f6', hover: '#e7e5de', active: '#e3e9f8', border: '#e3e1d9', modal: '#faf9f6', codeBg: 'rgba(240, 238, 232, 0.8)' };
  const setBg = (name: string, hex: string): void => {
    if (brightnessFactor === 1) bodyStyle.removeProperty(name);
    else bodyStyle.setProperty(name, scaleColor(hex, brightnessFactor));
  };
  setBg('--bg', base.bg);
  setBg('--bg-editor', base.editor);
  setBg('--bg-sidebar', base.sidebar);
  setBg('--bg-topbar', base.topbar);
  setBg('--bg-hover', base.hover);
  setBg('--bg-active', base.active);
  setBg('--border', base.border);
  setBg('--modal-bg', base.modal);
  if (brightnessFactor === 1) bodyStyle.removeProperty('--code-bg');
  else bodyStyle.setProperty('--code-bg', scaleRgba(base.codeBg, brightnessFactor));
  const workspace = document.getElementById('workspace');
  if (workspace) {
    const hasVideo = Boolean(settings.bgVideoData || settings.bgVideo);
    const bgUrl = hasVideo
      ? 'none'
      : settings.bgImageData
        ? 'url("' + settings.bgImageData + '")'
        : settings.bgImage
          ? 'url("app://bundle/fs/' + encodeURIComponent(settings.bgImage) + '")'
          : 'none';
    const hasBg = bgUrl !== 'none' || hasVideo;
    workspace.style.setProperty('--bg-image', bgUrl);
    workspace.style.setProperty('--bg-sidebar-mask', hasBg ? 'transparent' : 'var(--bg-sidebar)');
    workspace.style.setProperty('--bg-content-mask', hasBg ? 'transparent' : 'var(--bg-editor)');
    workspace.style.setProperty('--bg-image-opacity', String(settings.bgImageOpacity / 100));
    workspace.style.setProperty('--bg-image-pos', settings.bgImagePos);
  }
  void syncBgVideo(settings);
}
