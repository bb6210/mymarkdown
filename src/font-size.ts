import { $mark, $remark } from '@milkdown/kit/utils';
import type { MarkSchema } from '@milkdown/transformer';
import type { MdAstNode } from './paragraph-style';

// 行内字号：选中文字局部设置（对标题、列表等任意文本块生效）
// 保存为 <span style="font-size:Npx">…</span>，往返无损

const SPAN_TAG_RE = /^<span\b([^>]*)>$/i;
const SPAN_CLOSE_RE = /^<\/span>\s*$/i;
const FS_STYLE_RE = /\bfont-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i;
const PX_RE = /\b(\d+(?:\.\d+)?)px/i;

// 从 <span …> 的标签属性里提取 font-size 数值
export function spanFontSize(attrs: string): string | null {
  const m = /style\s*=\s*"([^"]*)"/i.exec(attrs);
  if (!m) return null;
  const fs = FS_STYLE_RE.exec(m[1]);
  return fs ? fs[1] : null;
}

// remark 对行内标签是透明解析：<span style="font-size:Npx">…</span> 会变成
// html(开标签) + 中间内容节点 + html(闭标签)，这里把它们合并成 fontSize 节点
export function transformFontSizeSpans(nodes: MdAstNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'html' && typeof node.value === 'string') {
      const open = SPAN_TAG_RE.exec(node.value.trim());
      if (open) {
        const px = spanFontSize(open[1]);
        if (px) {
          let depth = 0;
          let closeIdx = -1;
          for (let j = i + 1; j < nodes.length; j++) {
            const n = nodes[j];
            if (n.type !== 'html' || typeof n.value !== 'string') continue;
            const val = n.value.trim();
            if (SPAN_TAG_RE.test(val)) {
              depth++;
              continue;
            }
            if (SPAN_CLOSE_RE.test(val)) {
              if (depth === 0) {
                closeIdx = j;
                break;
              }
              depth--;
            }
          }
          if (closeIdx > i + 1) {
            const children = nodes.slice(i + 1, closeIdx);
            nodes.splice(i, closeIdx - i + 1, { type: 'fontSize', px, children });
            transformFontSizeSpans(children);
            continue;
          }
        }
      }
    }
    if (Array.isArray(node.children)) transformFontSizeSpans(node.children);
  }
}

export const fontSizeMarkSpec = (): MarkSchema => ({
  attrs: { px: { default: '16' } },
  parseDOM: [
    {
      style: 'font-size',
      getAttrs: (value) => {
        const m = PX_RE.exec(String(value ?? ''));
        return m ? { px: m[1] } : false;
      },
    },
  ],
  toDOM: (mark) => ['span', { style: 'font-size:' + mark.attrs.px + 'px' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'fontSize',
    runner: (state, node, type) => {
      state.openMark(type, { px: node.px ? String(node.px) : '16' });
      if (node.children) state.next(node.children);
      else state.addText(String(node.value ?? ''));
      state.closeMark(type);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'fontSize',
    runner: (state, mark) => {
      state.withMark(mark, 'fontSize', undefined, { px: mark.attrs.px });
    },
  },
});

export const fontSizeMarkSchema = $mark('fontSize', fontSizeMarkSpec);

export const fontSizeRemark = $remark('md-font-size', () => {
  return () => (tree: any) => {
    if (Array.isArray(tree?.children)) transformFontSizeSpans(tree.children);
  };
});

// remark-stringify 自定义 handler：把 fontSize 节点输出为 <span style="font-size:Npx">…</span>
export const fontSizeStringifyHandler = (
  node: any,
  _parent: any,
  state: any,
  info: any,
): string => {
  const px = String(node.px ?? '16').replace(/px$/i, '');
  const open = '<span style="font-size:' + px + 'px">';
  const close = '</span>';
  const exit = state.enter('fontSize');
  const tracker = state.createTracker(info);
  let value = tracker.move(open);
  value += tracker.move(state.containerPhrasing(node, { before: value, after: close, ...tracker.current() }));
  value += tracker.move(close);
  exit();
  return value;
};