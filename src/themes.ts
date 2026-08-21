/* ---------- 主题模块：多主题并存 + 应用机制 ----------
 * 主题 = 基准（light/dark）+ UI 变量覆盖 + 自定义 CSS。
 * 变量通过 <style id="mm-theme-vars"> 注入，自定义 CSS 通过
 * <style id="mm-theme-custom-css"> 注入，与设置面板的计算变量互不干扰。 */

export interface ThemeDef {
  id: string;
  name: string;
  base: 'light' | 'dark';
  /** CSS 变量名 -> 值，仅允许 KNOWN_THEME_VARS 中的键 */
  variables: Record<string, string>;
  /** 用户自定义 CSS，可覆盖任意细节 */
  customCss: string;
  /** 内置主题不可删除 */
  builtin: boolean;
  updatedAt: number;
  /** 主题自带背景图绝对路径（null=无背景图） */
  bgImage: string | null;
  /** 背景图透明度（0-100，默认 20） */
  bgImageOpacity: number;
  /** 背景图水平位置 */
  bgImagePos: 'left' | 'center' | 'right';
  /** 背景图字节（data URL），文件丢失时兜底显示用；过大时为 null */
  bgImageData: string | null;
}

export const BUILTIN_LIGHT_ID = 'builtin-light';
export const BUILTIN_DARK_ID = 'builtin-dark';

/** 允许主题覆盖的 UI 变量白名单 */
export const KNOWN_THEME_VARS: ReadonlyArray<string> = [
  '--bg', '--bg-editor', '--bg-sidebar', '--bg-topbar', '--bg-hover', '--bg-active',
  '--text', '--text-dim', '--border', '--accent', '--accent-soft', '--danger',
  '--on-accent', '--on-danger', '--shadow', '--shadow-strong', '--modal-bg',
  '--selection-bg', '--inactive-selection-bg', '--success', '--mask',
  '--toast-bg', '--toast-text', '--code-head-bg',
  '--highlight-bg', '--highlight-border',
  '--md-pre-bg', '--md-code-bg', '--md-code-text', '--md-link', '--md-blockquote-border',
  '--tok-string', '--tok-number', '--tok-func', '--tok-attr',
  '--font-ui', '--font-code',
];

export const THEME_VAR_LABELS: Record<string, string> = {
  '--bg': '全局背景',
  '--bg-editor': '编辑区背景',
  '--bg-sidebar': '侧栏背景',
  '--bg-topbar': '顶栏背景',
  '--bg-hover': '悬停背景',
  '--bg-active': '激活背景',
  '--text': '主文字',
  '--text-dim': '次要文字',
  '--border': '边框',
  '--accent': '强调色',
  '--accent-soft': '强调色浅底',
  '--danger': '危险色',
  '--on-accent': '强调色上文字',
  '--on-danger': '危险色上文字',
  '--shadow': '阴影',
  '--shadow-strong': '强阴影',
  '--modal-bg': '弹窗背景',
  '--selection-bg': '选中项背景',
  '--inactive-selection-bg': '失焦选中背景',
  '--success': '成功色',
  '--mask': '遮罩',
  '--toast-bg': '提示条背景',
  '--toast-text': '提示条文字',
  '--code-head-bg': '代码块头部背景',
  '--highlight-bg': '查找高亮背景',
  '--highlight-border': '查找高亮边框',
  '--md-pre-bg': '代码块背景',
  '--md-code-bg': '行内代码背景',
  '--md-code-text': '行内代码文字',
  '--md-link': '链接色',
  '--md-blockquote-border': '引用块边框',
  '--tok-string': '代码·字符串',
  '--tok-number': '代码·数字',
  '--tok-func': '代码·函数',
  '--tok-attr': '代码·属性',
  '--font-ui': '界面字体',
  '--font-code': '代码字体',
};

/** 主题内嵌背景图的最大 data URL 长度（超过则不内嵌，避免撑爆 localStorage） */
export const MAX_BG_DATA_LEN = 6 * 1024 * 1024;

const STORAGE_KEY = 'mm-themes';
const VARS_STYLE_ID = 'mm-theme-vars';
const CSS_STYLE_ID = 'mm-theme-custom-css';

interface ThemeStore {
  activeId: string;
  list: ThemeDef[];
}

function defaultStore(): ThemeStore {
  return {
    activeId: BUILTIN_LIGHT_ID,
    list: [
      { id: BUILTIN_LIGHT_ID, name: '浅色', base: 'light', variables: {}, customCss: '', builtin: true, updatedAt: 0, bgImage: null, bgImageOpacity: 20, bgImagePos: 'center', bgImageData: null },
      { id: BUILTIN_DARK_ID, name: '深色', base: 'dark', variables: {}, customCss: '', builtin: true, updatedAt: 0, bgImage: null, bgImageOpacity: 20, bgImagePos: 'center', bgImageData: null },
    ],
  };
}

function makeId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let cached: ThemeStore | null = null;

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch (error) {
    console.error('[themes] persist failed', error);
    // 配额不足时去掉内嵌背景字节，保证主题列表仍能保存
    try {
      if (cached) {
        for (const item of cached.list) item.bgImageData = null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
      }
    } catch {
      /* 放弃保存 */
    }
  }
}

function normalizeVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (KNOWN_THEME_VARS.includes(key) && typeof value === 'string' && value.trim() !== '') {
        out[key] = value.trim();
      }
    }
  }
  return out;
}

function normalizeBgImage(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function normalizeBgOpacity(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 20;
}

function normalizeBgPos(raw: unknown): 'left' | 'center' | 'right' {
  return raw === 'left' || raw === 'right' ? raw : 'center';
}

function normalizeBgImageData(raw: unknown): string | null {
  return typeof raw === 'string' && raw.startsWith('data:image/') && raw.length <= MAX_BG_DATA_LEN ? raw : null;
}

export function getThemeStore(): { activeId: string; list: ThemeDef[] } {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const store = defaultStore();
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.activeId === 'string') store.activeId = r.activeId;
    if (Array.isArray(r.list)) {
      store.list = [];
      for (const item of r.list as Array<Record<string, unknown>>) {
        if (!item || typeof item.id !== 'string') continue;
        store.list.push({
          id: item.id,
          name: typeof item.name === 'string' && item.name.trim() ? item.name : '未命名主题',
          base: item.base === 'dark' ? 'dark' : 'light',
          variables: normalizeVars(item.variables),
          customCss: typeof item.customCss === 'string' ? item.customCss : '',
          builtin: item.builtin === true,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
          bgImage: normalizeBgImage(item.bgImage),
          bgImageOpacity: normalizeBgOpacity(item.bgImageOpacity),
          bgImagePos: normalizeBgPos(item.bgImagePos),
          bgImageData: normalizeBgImageData(item.bgImageData),
        });
      }
      const defaults = defaultStore().list;
      if (!store.list.some((t) => t.id === BUILTIN_LIGHT_ID)) store.list.unshift(defaults[0]);
      if (!store.list.some((t) => t.id === BUILTIN_DARK_ID)) store.list.push(defaults[1]);
      if (!store.list.some((t) => t.id === store.activeId)) store.activeId = store.list[0].id;
    }
  }
  cached = store;
  return cached;
}

export function listThemes(): ThemeDef[] {
  return getThemeStore().list;
}

export function getTheme(id: string): ThemeDef | undefined {
  return getThemeStore().list.find((t) => t.id === id);
}

export function getActiveTheme(): ThemeDef {
  const store = getThemeStore();
  return store.list.find((t) => t.id === store.activeId) ?? store.list[0];
}

export function saveTheme(theme: ThemeDef): void {
  const store = getThemeStore();
  const copy: ThemeDef = {
    ...theme,
    name: theme.name.trim() || '未命名主题',
    variables: normalizeVars(theme.variables),
    customCss: theme.customCss ?? '',
    updatedAt: Date.now(),
    bgImage: normalizeBgImage(theme.bgImage),
    bgImageOpacity: normalizeBgOpacity(theme.bgImageOpacity),
    bgImagePos: normalizeBgPos(theme.bgImagePos),
    bgImageData: normalizeBgImageData(theme.bgImageData),
  };
  const idx = store.list.findIndex((t) => t.id === theme.id);
  if (idx >= 0) store.list[idx] = copy;
  else store.list.push(copy);
  persist();
}

export function createTheme(name: string, base: 'light' | 'dark', source?: ThemeDef): ThemeDef {
  const theme: ThemeDef = {
    id: makeId(),
    name: name.trim() || '新主题',
    base,
    variables: source ? { ...source.variables } : {},
    customCss: source?.customCss ?? '',
    builtin: false,
    updatedAt: Date.now(),
    bgImage: source?.bgImage ?? null,
    bgImageOpacity: source?.bgImageOpacity ?? 20,
    bgImagePos: source?.bgImagePos ?? 'center',
    bgImageData: source?.bgImageData ?? null,
  };
  saveTheme(theme);
  return theme;
}

export function deleteTheme(id: string): boolean {
  const store = getThemeStore();
  const target = store.list.find((t) => t.id === id);
  if (!target || target.builtin) return false;
  store.list = store.list.filter((t) => t.id !== id);
  if (store.activeId === id) store.activeId = store.list[0].id;
  persist();
  return true;
}

export function resetAllThemes(): void {
  const store = getThemeStore();
  const defaults = defaultStore();
  store.list = defaults.list;
  store.activeId = defaults.activeId;
  persist();
}

export function setActiveThemeId(id: string): void {
  const store = getThemeStore();
  if (!store.list.some((t) => t.id === id)) return;
  store.activeId = id;
  persist();
}

/** 应用主题：控制 dark 类 + 注入变量与自定义 CSS */
export function applyTheme(theme: ThemeDef): void {
  document.body.classList.toggle('dark', theme.base === 'dark');
  let varsStyle = document.getElementById(VARS_STYLE_ID) as HTMLStyleElement | null;
  if (!varsStyle) {
    varsStyle = document.createElement('style');
    varsStyle.id = VARS_STYLE_ID;
    document.head.appendChild(varsStyle);
  }
  const entries = Object.entries(theme.variables);
  varsStyle.textContent = entries.length
    ? 'body, body.dark {\n' + entries.map(([k, v]) => '  ' + k + ': ' + v + ';').join('\n') + '\n}'
    : '';
  let cssStyle = document.getElementById(CSS_STYLE_ID) as HTMLStyleElement | null;
  if (!cssStyle) {
    cssStyle = document.createElement('style');
    cssStyle.id = CSS_STYLE_ID;
    document.head.appendChild(cssStyle);
  }
  cssStyle.textContent = theme.customCss;
}

export function activateTheme(id: string): void {
  const theme = getTheme(id);
  if (!theme) return;
  setActiveThemeId(id);
  applyTheme(theme);
}