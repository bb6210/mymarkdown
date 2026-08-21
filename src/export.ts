export interface TextStats {
  chars: number;
  words: number;
}

export function countStats(markdown: string): TextStats {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  const chars = text.replace(/\s/g, '').length;
  return { chars, words };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function dirname(filePath: string): string | null {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (idx <= 0) return null;
  const parent = filePath.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return null;
  return parent;
}

export function buildExportHtml(title: string, bodyHtml: string): string {
  const styles = `
    body { font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; max-width: 840px; margin: 40px auto; padding: 0 28px; color: #2e3440; line-height: 1.75; font-size: 15px; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.3em 0 0.6em; font-weight: 600; }
    h1 { font-size: 1.9em; border-bottom: 1px solid #e5e9f0; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #eef1f6; padding-bottom: 0.25em; }
    h3 { font-size: 1.25em; }
    p { margin: 0.7em 0; }
    p.md-indent { text-indent: 2em; }
    p.md-dropcap::first-letter { float: left; font-size: 3em; line-height: 0.85; padding: 0.05em 0.12em 0 0; font-weight: 600; }
    a { color: #4c6ef5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: Consolas, "Cascadia Code", "Courier New", monospace; background: #eef1f6; padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #eef1f6; padding: 14px 16px; border-radius: 8px; overflow-x: auto; line-height: 1.5; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #81a1c1; background: #f6f8fb; margin: 0.8em 0; padding: 2px 16px; color: #4c566a; }
    blockquote p { margin: 0.5em 0; }
    ul, ol { padding-left: 1.6em; }
    li { margin: 0.25em 0; }
    table { border-collapse: collapse; margin: 1em 0; width: 100%; }
    th, td { border: 1px solid #d8dee9; padding: 7px 12px; text-align: left; }
    th { background: #eef1f6; font-weight: 600; }
    tr:nth-child(even) td { background: #fafbfd; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #e5e9f0; margin: 1.6em 0; }
    .task-list-item { list-style: none; }
  `;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function isRelativeImageSrc(src: string): boolean {
  return !/^(data:|https?:|file:|app:|blob:|\/|[A-Za-z]:[\\/])/i.test(src);
}

export function resolveImagePath(baseDir: string, src: string): string {
  const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // keep original value
  }
  return base + '/' + decoded.replace(/\\/g, '/');
}

export async function inlineImagesInHtml(
  html: string,
  baseDir: string | null,
  readDataUrl: (filePath: string) => Promise<string | null>,
): Promise<string> {
  if (!baseDir) return html;
  const srcs: string[] = [];
  html.replace(/src="([^"]*)"/g, (_match, src: string) => {
    srcs.push(src);
    return '';
  });
  const dataUrlBySrc = new Map<string, string>();
  for (const src of srcs) {
    if (dataUrlBySrc.has(src) || !isRelativeImageSrc(src)) continue;
    const abs = resolveImagePath(baseDir, src);
    const dataUrl = await readDataUrl(abs);
    if (dataUrl) dataUrlBySrc.set(src, dataUrl);
  }
  if (dataUrlBySrc.size === 0) return html;
  return html.replace(/src="([^"]*)"/g, (_match, src: string) => {
    const replaced = dataUrlBySrc.get(src);
    return 'src="' + (replaced ?? src) + '"';
  });
}