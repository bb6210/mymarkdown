import { paragraphSchema } from '@milkdown/kit/preset/commonmark';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import { $remark } from '@milkdown/kit/utils';

/* ---------- 段落排版：首行缩进 / 首字下沉 ---------- */

// 轻量 mdast 节点结构（用于把 <p class="md-indent|md-dropcap"> 的 HTML 还原成 markdown AST）
interface MdAstNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string;
  children?: MdAstNode[];
  [key: string]: unknown;
}

// 把内联 HTML 片段转换为 mdast 节点（与 Markdown 内联语法一一对应）
function domToMdast(parent: HTMLElement | DocumentFragment, out: MdAstNode[]): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      const value = child.nodeValue ?? '';
      if (value) out.push({ type: 'text', value });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const children: MdAstNode[] = [];
    switch (tag) {
      case 'strong':
      case 'b':
        domToMdast(el, children);
        out.push({ type: 'strong', children });
        break;
      case 'em':
      case 'i':
        domToMdast(el, children);
        out.push({ type: 'emphasis', children });
        break;
      case 'del':
      case 's':
      case 'strike':
        domToMdast(el, children);
        out.push({ type: 'delete', children });
        break;
      case 'code':
        out.push({ type: 'inlineCode', value: el.textContent ?? '' });
        break;
      case 'a':
        domToMdast(el, children);
        out.push({
          type: 'link',
          url: el.getAttribute('href') ?? '',
          title: el.getAttribute('title'),
          children,
        });
        break;
      case 'img':
        out.push({
          type: 'image',
          url: el.getAttribute('src') ?? '',
          alt: el.getAttribute('alt') ?? '',
          title: el.getAttribute('title'),
        });
        break;
      case 'br':
        out.push({ type: 'break' });
        break;
      case 'span': {
        const fs = el.style.fontSize || '';
        const m2 = /(\d+(?:\.\d+)?)px/i.exec(fs);
        if (m2) {
          domToMdast(el, children);
          out.push({ type: 'fontSize', px: m2[1], children });
        } else {
          domToMdast(el, children);
          out.push(...children);
        }
        break;
      }
      default:
        domToMdast(el, children);
        out.push(...children);
        break;
    }
  }
}

const MD_PARA_STYLE_RE = /^<p\b([^>]*)>([\s\S]*)<\/p>\s*$/i;

// 识别 <p class="md-indent|md-dropcap">…</p> 的原始 HTML，转成带排版属性的段落 mdast 节点
function htmlToStyledParagraph(value: string): MdAstNode | null {
  const m = MD_PARA_STYLE_RE.exec(value.trim());
  if (!m) return null;
  const classAttr = /class\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? '';
  const styleAttr = /style\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? '';
  const classes = classAttr.split(/\s+/);
  const indent = classes.includes('md-indent');
  const dropcap = classes.includes('md-dropcap');
  const fsMatch = /\bfont-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i.exec(styleAttr);
  const fontSize = fsMatch ? fsMatch[1] : '';
  if (!indent && !dropcap && !fontSize) return null;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = m[2];
  const children: MdAstNode[] = [];
  domToMdast(wrapper, children);
  return { type: 'paragraph', indent, dropcap, fontSize, children };
}

function transformStyledParagraphs(nodes: MdAstNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'html' && typeof node.value === 'string') {
      const replaced = htmlToStyledParagraph(node.value);
      if (replaced) {
        nodes[i] = replaced;
        continue;
      }
    }
    // Milkdown 的 remarkHTMLTransformer 会把块级 HTML 包成 paragraph(html)，
    // 需要把带样式的段落从包裹段落里“提”出来，否则嵌套段落无法通过内容校验会被丢弃
    if (
      node.type === 'paragraph' &&
      Array.isArray(node.children) &&
      node.children.length === 1 &&
      node.children[0] &&
      node.children[0].type === 'html' &&
      typeof node.children[0].value === 'string'
    ) {
      const replaced = htmlToStyledParagraph(node.children[0].value);
      if (replaced) {
        nodes[i] = replaced;
        continue;
      }
    }
    if (Array.isArray(node.children)) transformStyledParagraphs(node.children);
  }
}

const paragraphStyleRemark = $remark('md-paragraph-style', () => {
  return () => (tree: any) => {
    if (Array.isArray(tree?.children)) transformStyledParagraphs(tree.children);
  };
});

// 扩展段落 schema：增加 indent / dropcap 属性，并在 Markdown 里以原始 HTML 保存
const paragraphSchemaExt = paragraphSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx);
  const prevToDOM = spec.toDOM!;
  const prevParseMarkdown = spec.parseMarkdown;
  const prevToMarkdown = spec.toMarkdown;
  return {
    ...spec,
    attrs: {
      ...(spec.attrs ?? {}),
      indent: { default: false },
      dropcap: { default: false },
      fontSize: { default: '' },
    },
    parseDOM: [
      {
        tag: 'p',
        getAttrs: (dom) => ({
          indent: dom.classList.contains('md-indent'),
          dropcap: dom.classList.contains('md-dropcap'),
          fontSize: (dom.style.fontSize || '').replace(/px$/i, ''),
        }),
      },
    ],
    toDOM: (node): ReturnType<typeof prevToDOM> => {
      const base = prevToDOM(node);
      const arr = Array.isArray(base) ? [...base] : [base];
      if (arr[1] && typeof arr[1] === 'object') {
        const attrsObj = { ...(arr[1] as Record<string, string>) };
        const extra = [node.attrs.indent ? 'md-indent' : '', node.attrs.dropcap ? 'md-dropcap' : '']
          .filter(Boolean)
          .join(' ');
        if (extra) {
          attrsObj.class = ((attrsObj.class as string) ?? '').trim()
            ? attrsObj.class + ' ' + extra
            : extra;
        }
        if (node.attrs.fontSize) {
          const px = String(node.attrs.fontSize).replace(/px$/i, '');
          attrsObj.style = ((attrsObj.style as string) ?? '').trim()
            ? attrsObj.style + ';font-size:' + px + 'px'
            : 'font-size:' + px + 'px';
        }
        if (extra || node.attrs.fontSize) arr[1] = attrsObj;
      }
      return arr as unknown as ReturnType<typeof prevToDOM>;
    },
    parseMarkdown: {
      match: (node) => node.type === 'paragraph',
      runner: (state, node, type) => {
        if (!node.indent && !node.dropcap && !node.fontSize) {
          return prevParseMarkdown.runner(state, node, type);
        }
        state.openNode(type, {
          indent: node.indent === true,
          dropcap: node.dropcap === true,
          fontSize: node.fontSize ? String(node.fontSize) : '',
        });
        if (node.children) state.next(node.children);
        else state.addText(String(node.value ?? ''));
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'paragraph',
      runner: (state, node) => {
        if (!node.attrs.indent && !node.attrs.dropcap && !node.attrs.fontSize) {
          return prevToMarkdown.runner(state, node);
        }
        const classes = [node.attrs.indent ? 'md-indent' : '', node.attrs.dropcap ? 'md-dropcap' : '']
          .filter(Boolean)
          .join(' ');
        const fragment = DOMSerializer.fromSchema(node.type.schema).serializeFragment(node.content);
        const container = document.createElement('div');
        container.appendChild(fragment);
        const htmlAttrs: string[] = [];
        if (classes) htmlAttrs.push('class="' + classes + '"');
        if (node.attrs.fontSize) {
          htmlAttrs.push('style="font-size:' + String(node.attrs.fontSize).replace(/px$/i, '') + 'px"');
        }
        state.addNode(
          'html',
          undefined,
          '<p' + (htmlAttrs.length ? ' ' + htmlAttrs.join(' ') : '') + '>' + container.innerHTML + '</p>',
        );
      },
    },
  };
});
export { paragraphSchemaExt, paragraphStyleRemark };
export { domToMdast, htmlToStyledParagraph };
export type { MdAstNode };

