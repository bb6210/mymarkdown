export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isImage?: boolean;
}

export interface ExportResult {
  canceled: boolean;
  filePath: string | null;
}

export interface SaveImagePayload {
  data: Uint8Array;
  dir: string;
  name?: string;
  ext?: string;
}

export interface ImageFileData {
  name: string;
  type: string;
  data: Uint8Array;
}


/** 背景视频可内嵌进设置/主题的 data URL 最大长度（localStorage 容量有限，仅小视频内嵌） */
export const MAX_BG_VIDEO_DATA_LEN = 4 * 1024 * 1024;
/** 背景图片/视频文件最大体积（超过则拒绝读取，避免超大 base64 字符串跨 IPC 拖垮渲染进程） */
export const MAX_BG_MEDIA_FILE_BYTES = 200 * 1024 * 1024;

export interface VideoReadResult {
  /** 可内嵌时返回 data URL（≤4MB），否则为 null */
  data: string | null;
  /** 是否可内嵌（文件 ≤ 4MB，可写入 localStorage） */
  embeddable: boolean;
  /** 是否超过文件体积硬上限被拒绝 */
  tooLarge: boolean;
  /** 文件字节数 */
  size: number;
}

/** 背景视频整文件读取结果（用于 Blob URL 播放，避免自定义协议对媒体流的限制） */
export interface VideoFileResult {
  name: string;
  type: string;
  data: Uint8Array;
  size: number;
}

export interface ExportHtmlOptions {
  baseDir?: string | null;
}

export interface ThemeExportPayload {
  name: string;
  base: 'light' | 'dark';
  variables: Record<string, string>;
  customCss: string;
  settings: Record<string, unknown>;
  /** data URL，背景图超过 8MB 时为 null（不内嵌） */
  bgImageBase64: string | null;
  /** data URL，背景视频超过 30MB 时为 null（不内嵌） */
  bgVideoBase64: string | null;
}

export interface CommunityAuth {
  baseUrl: string;
  username: string;
  password: string;
  token: string;
}

export interface CommunityPublishPayload {
  type: 'doc' | 'theme';
  title?: string;
  content?: string;
  images?: Array<{ name: string; data: string }>;
  name?: string;
  description?: string;
  baseTheme?: 'light' | 'dark';
  fileName?: string;
  fileData?: string;
  previewName?: string;
  previewData?: string;
}

export interface CommunityLoginResult {
  ok: boolean;
  token?: string;
  error?: string;
}

export interface CommunityPublishResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
  needLogin?: boolean;
}

export interface ThemeImportResult {
  canceled: boolean;
  error?: string;
  name?: string;
  base?: 'light' | 'dark';
  variables?: Record<string, string>;
  customCss?: string;
  settings?: Record<string, unknown>;
  /** 主题文件里内嵌的背景图（data URL），原样透传给主题数据 */
  bgImageBase64?: string | null;
  /** 主题文件里内嵌的背景视频（data URL），原样透传给主题数据 */
  bgVideoBase64?: string | null;
}

export type UpdateEventType =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateEvent {
  type: UpdateEventType;
  version?: string;
  percent?: number;
  message?: string;
}
export interface MarkdownApi {
  openFolder(): Promise<string | null>;
  readDir(dir: string): Promise<FileEntry[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  saveImage(payload: SaveImagePayload): Promise<string | null>;
  readImageDataUrl(filePath: string): Promise<string | null>;
  readVideoDataUrl(filePath: string, maxBytes?: number): Promise<VideoReadResult | null>;
  readVideoFile(filePath: string, maxBytes?: number): Promise<VideoFileResult | null>;
  openImage(): Promise<string | null>;
  openVideo(): Promise<string | null>;
  readImageFile(filePath: string): Promise<ImageFileData | null>;
  createFile(dir: string, name: string): Promise<string | null>;
  createDir(dir: string, name: string): Promise<string | null>;
  copyEntry(srcPath: string, destDir: string): Promise<string | null>;
  renameFile(oldPath: string, newName: string): Promise<string | null>;
  deleteFile(filePath: string): Promise<boolean>;
  exportMarkdown(defaultName: string, content: string): Promise<ExportResult>;
  exportHtml(defaultName: string, html: string, options?: ExportHtmlOptions): Promise<ExportResult>;
  exportPdf(defaultName: string, html: string): Promise<ExportResult>;
  exportTheme(payload: ThemeExportPayload): Promise<ExportResult>;
  importTheme(): Promise<ThemeImportResult>;
  copyImageToClipboard(filePath: string): Promise<boolean>;
  openImageExternally(filePath: string): Promise<void>;
  writeImageFile(filePath: string, data: Uint8Array): Promise<boolean>;
  communityLogin(auth: CommunityAuth): Promise<CommunityLoginResult>;
  saveCommunityAuth(auth: CommunityAuth): Promise<boolean>;
  loadCommunityAuth(): Promise<CommunityAuth | null>;
  clearCommunityAuth(): Promise<boolean>;
  publishToCommunity(auth: CommunityAuth, payload: CommunityPublishPayload): Promise<CommunityPublishResult>;
  openCommunityBrowser(url: string): Promise<void>;
  checkForUpdates(): Promise<boolean>;
  downloadUpdate(): Promise<boolean>;
  quitAndInstall(): Promise<void>;
  onUpdate(callback: (event: UpdateEvent) => void): void;
  onMenu(callback: (action: string) => void): void;
  onOpenFile(callback: (path: string) => void): void;
}
