import { Editor, rootCtx, defaultValueCtx, parserCtx, serializerCtx, editorViewCtx, editorStateCtx } from '@milkdown/kit/core';
import { codeBlockSchema, commonmark, htmlSchema, imageSchema } from '@milkdown/kit/preset/commonmark';
import { columnResizingPlugin, gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { trailing } from '@milkdown/plugin-trailing';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { DOMSerializer, Fragment, Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, NodeSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { keymap } from '@milkdown/kit/prose/keymap';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $prose, $view } from '@milkdown/kit/utils';
import { paragraphSchemaExt, paragraphStyleRemark } from './paragraph-style';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { fontSizeMarkSchema, fontSizeRemark, fontSizeStringifyHandler } from './font-size';
import { CodeBlockView } from './code-block-view';
import { tableCellAlignSchema, tableHeaderAlignSchema } from './table-align';
import { rowResizePlugin, tableHeaderRowHeightSchema, tableRowHeightSchema } from './table-row-height';
import { tableSizeRemark, tableSizeSchema } from './table-size';
import { columnResizeFixPlugin } from './table-column-resize';

// 按文件缓存解析结果，避免大文件反复切换时重复解析
const parsedDocCache = new Map<string, Node>();
const MAX_CACHE = 60;

export function invalidateDocCache(key: string): void {
  parsedDocCache.delete(key);
}

// 图片显示路径解析：markdown 中保存相对路径，渲染时映射到磁盘绝对路径（经 app://bundle/fs/ 协议加载）
let imageBaseDir: string | null = null;

export function setImageBaseDir(dir: string | null): void {
  imageBaseDir = dir;
}

function tryDecodeUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAbsoluteSrc(src: string): boolean {
  return /^(data:|https?:|file:|app:|blob:|\/|[A-Za-z]:[\\/])/i.test(src);
}

function resolveDiskPath(baseDir: string, src: string): string {
  const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return base + '/' + tryDecodeUrl(src).replace(/\\/g, '/');
}

export function resolveImageFilePath(src: string): string | null {
  if (!imageBaseDir || isAbsoluteSrc(src)) return null;
  return resolveDiskPath(imageBaseDir, src);
}

function resolveImageDisplaySrc(src: string): string {
  if (!imageBaseDir || isAbsoluteSrc(src)) return src;
  return 'app://bundle/fs/' + encodeURIComponent(resolveDiskPath(imageBaseDir, src));
}

function basenameOf(src: string): string {
  return src.split(/[\\/]/).filter(Boolean).pop() ?? src;
}


function refreshImageFades(): void {
  cancelAnimationFrame(fadeRaf);
  fadeRaf = requestAnimationFrame(() => {
    document.querySelectorAll<HTMLImageElement>('#editor img.mymarkdown-img-el').forEach((img) => {
      const wrap = img.parentElement;
      const full = !!wrap && wrap.clientWidth > 0 && img.offsetWidth >= wrap.clientWidth - 1;
      img.classList.toggle('fade-left', !full);
    });
  });
}
let fadeRaf = 0;
window.addEventListener('resize', refreshImageFades);

function makeImageEl(src: string, alt: string, title: string, styleCss?: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'mymarkdown-img-el';
  img.draggable = false;
  img.src = resolveImageDisplaySrc(src);
  img.addEventListener('load', refreshImageFades);
  if (styleCss) img.style.cssText = styleCss;
  if (alt) img.alt = alt;
  if (title) img.title = title;
  img.addEventListener('error', () => {
    const placeholder = document.createElement('span');
    placeholder.className = 'mymarkdown-img-missing';
    placeholder.textContent = '图片缺失：' + (alt || basenameOf(src));
    placeholder.title = '点击重新加载';
    placeholder.addEventListener('click', () => {
      img.removeAttribute('src');
      img.src = resolveImageDisplaySrc(src);
    });
    img.replaceWith(placeholder);
  });
  return img;
}

class ImageNodeView implements NodeView {
  dom: HTMLElement;

  constructor(node: Node) {
    this.dom = document.createElement('span');
    this.dom.className = 'mymarkdown-img';
    this.update(node);
  }

  update(node: Node): boolean {
    this.dom.replaceChildren(
      makeImageEl(
        String(node.attrs.src ?? ''),
        String(node.attrs.alt ?? ''),
        String(node.attrs.title ?? ''),
      ),
    );
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(): boolean {
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('selected');
  }
}

function parseImgTag(tag: string): HTMLImageElement | null {
  const tmp = document.createElement('div');
  tmp.innerHTML = tag;
  const img = tmp.querySelector('img');
  if (!img) return null;
  const src = img.getAttribute('src') ?? '';
  const style = img.getAttribute('style') ?? '';
  const alt = img.getAttribute('alt') ?? '';
  const title = img.getAttribute('title') ?? '';
  return makeImageEl(src, alt, title, style || undefined);
}

class HtmlNodeView implements NodeView {
  dom: HTMLElement;

  constructor(node: Node) {
    this.dom = document.createElement('span');
    this.dom.dataset.type = 'html';
    this.update(node);
  }

  update(node: Node): boolean {
    const value = String(node.attrs.value ?? '');
    const imgTag = /<img\b[^>]*>/i.exec(value);
    if (imgTag) {
      const el = parseImgTag(imgTag[0]);
      if (el) {
        this.dom.replaceChildren(el);
        return true;
      }
    }
    this.dom.textContent = value;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(): boolean {
    return true;
  }
}

const imageView = $view(imageSchema.node, () => (node: Node) => new ImageNodeView(node));
const htmlView = $view(htmlSchema.node, () => (node: Node) => new HtmlNodeView(node));
const codeBlockView = $view(codeBlockSchema.node, (): NodeViewConstructor => (node, view, getPos) => new CodeBlockView(node, view, getPos));

// 删除指定范围代码块；若它是文档唯一块则替换为空段落，避免文档为空
function dispatchDeleteCodeBlock(state: EditorState, dispatch: (tr: Transaction) => void, start: number, end: number): void {
  if (state.doc.childCount === 1) {
    const para = state.schema.nodes.paragraph.createAndFill();
    if (!para) return;
    const tr = state.tr.replaceWith(start, end, para);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
    return;
  }
  const tr = state.tr.delete(start, end);
  const cursor = TextSelection.near(tr.doc.resolve(start), -1);
  dispatch((cursor ? tr.setSelection(cursor) : tr).scrollIntoView());
}

// 右键菜单「删除代码块」：删除整个代码块（不要求内容为空）
export function deleteCodeBlockRange(view: EditorView, from: number, to: number): void {
  dispatchDeleteCodeBlock(view.state, (tr) => view.dispatch(tr), from, to);
}

// 光标位于空代码块内时，退格/删除整块；若它是文档唯一块则替换为空段落，避免文档为空
function deleteEmptyCodeBlock(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return false;
  const $from = sel.$from;
  if ($from.parent.type.name !== 'code_block') return false;
  if ($from.parent.content.size > 0) return false;
  if (!dispatch) return true;
  dispatchDeleteCodeBlock(state, dispatch, $from.before($from.depth), $from.after($from.depth));
  return true;
}

// 代码块内按 Tab 插入制表符，避免浏览器默认把 Tab 当成切换焦点
const codeTabKeymap = $prose(() =>
  keymap({
    Tab: (state, dispatch): boolean => {
      if (state.selection.$from.parent.type.name !== 'code_block') return false;
      if (dispatch) dispatch(state.tr.insertText('\t').scrollIntoView());
      return true;
    },
    Backspace: deleteEmptyCodeBlock,
    Delete: deleteEmptyCodeBlock,
    // code_block NodeSelection + Enter: do not split, collapse cursor into the block
    Enter: (state, dispatch): boolean => {
      const sel = state.selection;
      if (sel instanceof NodeSelection && sel.node.type.name === 'code_block') {
        if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.from + 1)).scrollIntoView());
        return true;
      }
      // whole-block text selection + Enter: collapse to block end instead of replacing code with a newline
      if (!sel.empty && sel instanceof TextSelection) {
        const { $from, $to } = sel;
        if ($from.parent.type.name === 'code_block' && $from.sameParent($to) &&
          $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size) {
          if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, $to.pos)).scrollIntoView());
          return true;
        }
      }
      return false;
    },
    // Mod-Enter with whole block selected: create a paragraph after and move the cursor there
    'Mod-Enter': (state, dispatch): boolean => {
      const sel = state.selection;
      if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'code_block') return false;
      if (dispatch) {
        const paraType = state.schema.nodes.paragraph;
        if (paraType) {
          const para = paraType.createAndFill();
          if (para) {
            const tr = state.tr.insert(sel.to, para);
            dispatch(tr.setSelection(TextSelection.create(tr.doc, sel.to + 1)).scrollIntoView());
            return true;
          }
        }
      }
      return true;
    },
  }),
);

// mouse fallback: clicking below the last block (e.g. a code block) creates a trailing paragraph
// and moves the cursor there, so the cursor can leave the block with the mouse.
const clickTrailingPara = $prose(() =>
  new Plugin({
    props: {
      handleClick: (view, pos, event): boolean => {
        const doc = view.state.doc;
        if (pos < doc.content.size) return false;
        const last = doc.lastChild;
        if (!last || last.type.name === 'paragraph' || last.type.name === 'heading') return false;
        const caret = view.coordsAtPos(doc.content.size);
        if (!caret || event.clientY <= caret.bottom) return false;
        const paraType = view.state.schema.nodes.paragraph;
        if (!paraType) return false;
        const para = paraType.create();
        const tr = view.state.tr.insert(doc.content.size, para);
        tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(pos)));
        view.dispatch(tr);
        return true;
      },
    },
  }),
);
import { nord } from '@milkdown/theme-nord';
import '@milkdown/theme-nord/style.css';


export interface SearchMatch {
  from: number;
  to: number;
}

export const searchKey = new PluginKey<SearchMatch[]>('mm-search');

// 查找高亮：通过 dispatch meta 更新匹配位置，编辑器实时渲染高亮
export const searchPlugin = $prose(
  () =>
    new Plugin<SearchMatch[]>({
      key: searchKey,
      state: {
        init: () => [] as SearchMatch[],
        apply: (tr, value) => tr.getMeta(searchKey) ?? value,
      },
      props: {
        decorations(state) {
          const matches = searchKey.getState(state) ?? [];
          if (matches.length === 0) return undefined;
          return DecorationSet.create(
            state.doc,
            matches.map((m) => Decoration.inline(m.from, m.to, { class: 'mm-search-match' })),
          );
        },
      },
    }),
);

export interface EditorCallbacks {
  onMarkdownChange(markdown: string): void;
}

export async function createEditor(element: HTMLElement, callbacks: EditorCallbacks): Promise<Editor> {
  // 关闭编辑区原生拼写检查（英文下方红色波浪线）
  element.setAttribute('spellcheck', 'false');
  return await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, element);
      ctx.set(defaultValueCtx, '');
    })
    .config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        handlers: { ...(prev.handlers ?? {}), fontSize: fontSizeStringifyHandler },
      }));
    })
    .config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        callbacks.onMarkdownChange(markdown);
      });
    })
    .config(nord)
    .use(commonmark)
    .use(paragraphSchemaExt)
    .use(paragraphStyleRemark)
    .use(fontSizeMarkSchema)
    .use(fontSizeRemark)
    .use(imageView)
    .use(htmlView)
    .use(codeBlockView)
    .use(codeTabKeymap)
    .use(rowResizePlugin)
    .use(columnResizeFixPlugin)
    .use(columnResizingPlugin)
    .use(gfm)
    .use(tableCellAlignSchema)
    .use(tableHeaderAlignSchema)
    .use(tableRowHeightSchema)
    .use(tableHeaderRowHeightSchema)
    .use(tableSizeSchema)
    .use(tableSizeRemark)
    .use(history)
    .use(trailing)
    .use(clickTrailingPara)
    .use(searchPlugin)
    .use(listener)
    .create()
    .then((editor) => {
      const root = element.querySelector('.ProseMirror');
      if (root) root.setAttribute('spellcheck', 'false');
      return editor;
    });
}

export function setEditorContent(editor: Editor, markdown: string, cacheKey?: string): void {
  editor.action((ctx) => {
    const parser = ctx.get(parserCtx);
    const t0 = performance.now();
    let doc = cacheKey ? parsedDocCache.get(cacheKey) : undefined;
    if (!doc) {
      doc = parser(markdown);
      if (cacheKey) {
        if (parsedDocCache.size >= MAX_CACHE) {
          const first = parsedDocCache.keys().next().value;
          if (first !== undefined) parsedDocCache.delete(first);
        }
        parsedDocCache.set(cacheKey, doc);
      }
    }
    const t1 = performance.now();
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const docSize = state.doc.content.size;
    if (docSize === 0 && doc.content.size === 0) return;
    const tr = state.tr;
    if (doc.content.size === 0) {
      tr.delete(0, docSize);
    } else {
      tr.replaceWith(0, docSize, doc.content);
    }
    view.dispatch(tr);
    const t2 = performance.now();
    if (cacheKey && t2 - t0 > 20) {
      console.log(
        `[perf-editor] ${cacheKey.split(/[\\/]/).pop()} parse=${(t1 - t0).toFixed(1)}ms dispatch=${(t2 - t1).toFixed(1)}ms`,
      );
    }
  });
}

export function getEditorMarkdown(editor: Editor): string {
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorStateCtx).doc));
}

export function getEditorHtml(editor: Editor): string {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content);
    const container = document.createElement('div');
    container.appendChild(fragment);
    return container.innerHTML;
  });
}

export function getEditorView(editor: Editor): EditorView {
  return editor.action((ctx) => ctx.get(editorViewCtx));
}

// 图片独占一段插入：图片前后自动分段，光标落到图片下一行
function insertBlockImage(tr: Transaction, imageNode: Node): Transaction {
  const { selection, doc } = tr;
  if (!selection.empty) throw new Error('selection not empty');
  const $pos = selection.$from;
  const parent = $pos.parent;
  if (parent.type.name !== 'paragraph') throw new Error('not a paragraph');
  const start = $pos.start();
  const end = $pos.end();
  const pos = selection.from;
  const before = doc.slice(start, pos).content;
  const after = doc.slice(pos, end).content;
  const paraType = parent.type;
  const nodes: Node[] = [];
  if (before.childCount > 0) nodes.push(paraType.create(null, before));
  nodes.push(paraType.create(null, imageNode));
  if (after.childCount > 0) nodes.push(paraType.create(null, after));
  nodes.push(paraType.create(null));
  let cursor = start - 1 + 1;
  for (let i = 0; i < nodes.length - 1; i++) cursor += nodes[i].nodeSize;
  cursor += 1;
  tr = tr.replaceWith(start - 1, end + 1, Fragment.fromArray(nodes));
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
  return tr;
}

export function insertImageAtCursor(editor: Editor, src: string, appendToHistory = false): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const imageType = view.state.schema.nodes.image;
    if (!imageType) return;
    const node = imageType.create({ src, alt: '' });
    const { state } = view;
    let tr: Transaction | null = null;
    if (state.selection.empty) {
      try {
        tr = insertBlockImage(state.tr, node);
      } catch {
        tr = null;
      }
    }
    if (!tr) {
      try {
        tr = state.tr.replaceSelectionWith(node, false);
      } catch {
        // 光标位于不允许行内图片的位置（如代码块）时，追加到文档末尾
        tr = state.tr.insert(state.doc.content.size, node);
      }
    }
    if (appendToHistory) tr.setMeta('addToHistory', false);
    view.dispatch(tr);
    view.focus();
  });
}

export interface ImageHit {
  node: Node;
  from: number;
  to: number;
  src: string;
  isHtml: boolean;
}

function extractHtmlImgSrc(value: string): string {
  const m = /<img\b[^>]*\bsrc="([^"]*)"/i.exec(value);
  return m ? m[1] : '';
}

export function findImageAtPos(editor: Editor, pos: number): ImageHit | null {
  return editor.action((ctx) => findImageAtPosInDoc(ctx.get(editorStateCtx).doc, pos));
}

function findImageAtPosInDoc(doc: Node, pos: number): ImageHit | null {
  const from = Math.max(1, pos - 2);
  const to = Math.min(doc.content.size, pos + 2);
  for (let p = from; p <= to; p++) {
    const node = doc.nodeAt(p);
    if (!node) continue;
    if (node.type.name === 'image') {
      return { node, from: p, to: p + node.nodeSize, src: String(node.attrs.src ?? ''), isHtml: false };
    }
    if (node.type.name === 'html') {
      const src = extractHtmlImgSrc(String(node.attrs.value ?? ''));
      if (src) return { node, from: p, to: p + node.nodeSize, src, isHtml: true };
    }
  }
  return null;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function htmlWithWidth(value: string, pct: number): string {
  const tagMatch = /<img\b[^>]*>/i.exec(value);
  if (!tagMatch) return value;
  let tag = tagMatch[0];
  if (/\bstyle\s*=/i.test(tag)) {
    tag = tag.replace(/\bstyle\s*=\s*"[^"]*"/i, (styleAttr) => {
      const start = styleAttr.indexOf('"') + 1;
      const end = styleAttr.lastIndexOf('"');
      const styleBody = styleAttr.slice(start, end);
      const updated = styleBody.replace(/\bwidth\s*:\s*[^;"]+/i, 'width:' + pct + '%');
      const finalBody = /\bwidth\s*:/i.test(updated) ? updated : 'width:' + pct + '%;' + updated;
      return styleAttr.slice(0, start) + finalBody + styleAttr.slice(end);
    });
  } else {
    tag = tag.replace(/\s*\/?\s*>$/, ' style="width:' + pct + '%" />');
  }
  return value.replace(tagMatch[0], tag);
}

export function setImageWidth(editor: Editor, pos: number, pct: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const hit = findImageAtPosInDoc(view.state.doc, pos);
    if (!hit) return;
    let tr = view.state.tr;
    if (hit.isHtml) {
      tr = tr.setNodeMarkup(hit.from, undefined, { value: htmlWithWidth(String(hit.node.attrs.value ?? ''), pct) });
    } else {
      const htmlType = view.state.schema.nodes.html;
      if (!htmlType) return;
      const value = '<img src="' + escapeAttr(hit.src) + '" style="width:' + pct + '%" />';
      tr = tr.replaceWith(hit.from, hit.to, htmlType.create({ value }));
    }
    view.dispatch(tr);
  });
}

export function setImageAlign(editor: Editor, pos: number, align: 'left' | 'right' | 'center'): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const hit = findImageAtPosInDoc(view.state.doc, pos);
    if (!hit) return;
    const htmlType = view.state.schema.nodes.html;
    if (!htmlType) return;
    let width = 100;
    if (hit.isHtml) {
      const m = /width\s*:\s*(\d+(?:\.\d+)?)%/i.exec(String(hit.node.attrs.value ?? ''));
      if (m) width = Number(m[1]);
    }
    const style = align === 'center' ? 'width:' + width + '%;float:none' : 'width:' + width + '%;float:' + align;
    const value = '<img src="' + escapeAttr(hit.src) + '" style="' + style + '" />';
    view.dispatch(view.state.tr.replaceWith(hit.from, hit.to, htmlType.create({ value })));
  });
}

export function updateImageSrc(editor: Editor, pos: number, newSrc: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const hit = findImageAtPosInDoc(view.state.doc, pos);
    if (!hit) return;
    let tr = view.state.tr;
    if (hit.isHtml) {
      const value = String(hit.node.attrs.value ?? '');
      const updated = value.replace(/(<img\b[^>]*\bsrc=")[^"]*(")/i, '$1' + escapeAttr(newSrc) + '$2');
      tr = tr.setNodeMarkup(hit.from, undefined, { value: updated });
    } else {
      tr = tr.setNodeMarkup(hit.from, undefined, { src: newSrc, alt: String(hit.node.attrs.alt ?? '') });
    }
    view.dispatch(tr);
  });
}

export function removeImageAt(editor: Editor, pos: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const hit = findImageAtPosInDoc(view.state.doc, pos);
    if (!hit) return;
    view.dispatch(view.state.tr.delete(hit.from, hit.to));
  });
}