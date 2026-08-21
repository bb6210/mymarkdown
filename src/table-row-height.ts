import { $nodeSchema, $prose } from '@milkdown/kit/utils';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { columnResizingPluginKey } from '@milkdown/kit/prose/tables';

/* ---------- 表格行高：行节点扩展 + 行高拖拽 ----------
 * prosemirror-tables 只支持列宽拖拽；这里给 table_row / table_header_row
 * 增加 height 属性（写入 tr 的 style），并实现行下边框拖拽调整行高。
 * 行高与列宽一样只保存在会话内（GFM Markdown 不包含行高）。 */

const GUIDE_CLASS = 'mm-row-resize-guide';
const CURSOR_CLASS = 'resize-row-cursor';
const MIN_ROW_HEIGHT = 24;
const EDGE = 6;

type RowDrag = { startY: number; startHeight: number; rowPos: number };
type RemarkState = any;

function parseRowAttrs(dom: HTMLElement | string): Record<string, unknown> {
  if (typeof dom === 'string') return {};
  const m = /^\s*(\d+(?:\.\d+)?)px/.exec(dom.style.height || '');
  return { height: m ? Math.round(Number(m[1])) : null };
}

function renderRowAttrs(node: Node, isHeader: boolean): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (isHeader) attrs['data-is-header'] = true;
  if (node.attrs.height) attrs.style = 'height:' + node.attrs.height + 'px';
  return attrs;
}

export const tableRowHeightSchema = $nodeSchema('table_row', () => ({
  content: '(table_cell)*',
  tableRole: 'row',
  disableDropCursor: true,
  attrs: { height: { default: null } },
  parseDOM: [{ tag: 'tr', getAttrs: parseRowAttrs }],
  toDOM: (node: Node) => ['tr', renderRowAttrs(node, false), 0],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === 'tableRow',
    runner: (state: RemarkState, node: any, type: unknown) => {
      const align = node.align as string[] | undefined;
      const children = node.children.map((x: any, i: number) => ({ ...x, align: x.align ?? align?.[i] }));
      state.openNode(type, { height: node.height ?? null });
      state.next(children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === 'table_row',
    runner: (state: RemarkState, node: Node) => {
      if (node.content.size === 0) return;
      state.openNode('tableRow');
      state.next(node.content);
      state.closeNode();
    },
  },
}));

export const tableHeaderRowHeightSchema = $nodeSchema('table_header_row', () => ({
  content: '(table_header)*',
  tableRole: 'row',
  disableDropCursor: true,
  attrs: { height: { default: null } },
  parseDOM: [
    { tag: 'tr[data-is-header]', getAttrs: parseRowAttrs },
    {
      tag: 'tr',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return false;
        return dom.querySelector('th') ? parseRowAttrs(dom) : false;
      },
    },
  ],
  toDOM: (node: Node) => ['tr', renderRowAttrs(node, true), 0],
  parseMarkdown: {
    match: (node: any) => Boolean(node.type === 'tableRow' && node.isHeader),
    runner: (state: RemarkState, node: any, type: unknown) => {
      const align = node.align as string[] | undefined;
      const children = node.children.map((x: any, i: number) => ({
        ...x,
        align: x.align ?? align?.[i],
        isHeader: node.isHeader,
      }));
      state.openNode(type, { height: node.height ?? null });
      state.next(children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === 'table_header_row',
    runner: (state: RemarkState, node: Node) => {
      if (node.content.size === 0) return;
      state.openNode('tableRow', void 0, { isHeader: true });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

export const rowResizePlugin = $prose(() => {
  let guide: HTMLDivElement | null = null;
  let hover: { rowPos: number; rect: DOMRect } | null = null;
  let dragging: RowDrag | null = null;
  let viewRef: EditorView | null = null;

  function getGuide(view: EditorView): HTMLDivElement {
    if (!guide || !guide.isConnected) {
      guide = document.createElement('div');
      guide.className = GUIDE_CLASS;
      view.dom.ownerDocument.body.appendChild(guide);
    }
    return guide;
  }

  function showGuide(view: EditorView, rect: DOMRect, y?: number): void {
    const el = getGuide(view);
    el.style.display = 'block';
    el.style.left = rect.left + 'px';
    el.style.top = (y ?? rect.bottom) + 'px';
    el.style.width = rect.width + 'px';
  }

  function hideGuide(): void {
    if (guide) guide.style.display = 'none';
  }

  function setCursor(view: EditorView, on: boolean): void {
    view.dom.classList.toggle(CURSOR_CLASS, on);
  }

  function clearColumnHandle(view: EditorView): void {
    const st = columnResizingPluginKey.getState(view.state);
    if (st && st.activeHandle > -1) {
      view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
    }
  }

  function findHoverRow(view: EditorView, event: MouseEvent): { rowPos: number; rect: DOMRect } | null {
    const target = event.target as HTMLElement;
    if (!target || !view.dom.contains(target)) return null;
    const tableEl = target.closest('table');
    if (!tableEl) return null;
    const rows = Array.from(tableEl.rows);
    if (rows.length === 0) return null;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      const dist = Math.abs(r.bottom - event.clientY);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best < 0 || bestDist > EDGE) return null;
    const rowEl = rows[best];
    const rect = rowEl.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(6, Math.max(1, rect.height / 2));
    const found = view.posAtCoords({ left: x, top: y });
    if (!found) {
      return null;
    }
    const $pos = view.state.doc.resolve(found.pos);
    for (let d = $pos.depth; d > 0; d--) {
      const node = $pos.node(d);
      if (node.type.spec.tableRole === 'row') {
        return { rowPos: $pos.before(d), rect };
      }
    }
    return null;
  }

  function onDragMove(e: MouseEvent): void {
    if (!dragging || !viewRef) return;
    try {
      const view = viewRef;
      const height = Math.max(MIN_ROW_HEIGHT, Math.round(dragging.startHeight + (e.clientY - dragging.startY)));
      const rowNode = view.state.doc.nodeAt(dragging.rowPos);
      if (!rowNode || rowNode.type.spec.tableRole !== 'row') {
        endDrag();
        return;
      }
      if (rowNode.attrs.height !== height) {
        view.dispatch(view.state.tr.setNodeMarkup(dragging.rowPos, null, { ...rowNode.attrs, height }));
      }
      const guideEl = getGuide(view);
      guideEl.style.display = 'block';
      guideEl.style.top = e.clientY + 'px';
    } catch (err) {
      endDrag();
    }
  }

  function endDrag(): void {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    dragging = null;
    hideGuide();
    if (viewRef) setCursor(viewRef, false);
  }

  function onDragEnd(): void {
    endDrag();
  }

  return new Plugin({
    key: new PluginKey<unknown>('mm-row-resize'),
    props: {
      handleDOMEvents: {
        mousemove: (view, event) => {
          if (!view.editable) return false;
          if (dragging) return true; // 行高拖拽进行中，独占鼠标
          try {
            const col = columnResizingPluginKey.getState(view.state);
            if (col && col.dragging) {
              if (hover) {
                hover = null;
                hideGuide();
                setCursor(view, false);
              }
              return false;
            }
            const info = findHoverRow(view, event);
            if (!info) {
              if (hover) {
                hover = null;
                hideGuide();
                setCursor(view, false);
              }
              return false;
            }
            hover = info;
            setCursor(view, true);
            showGuide(view, info.rect);
            clearColumnHandle(view);
            return true; // 行边界处拦截列宽插件
          } catch (err) {
            return false;
          }
        },
        mouseleave: (view) => {
          hideGuide();
          hover = null;
          setCursor(view, false);
          return false;
        },
        mousedown: (view, event) => {
          if (event.button !== 0 || !view.editable || dragging) return false;
          try {
            const info = hover ?? findHoverRow(view, event);
            if (!info) return false;
            const rowNode = view.state.doc.nodeAt(info.rowPos);
            if (!rowNode || rowNode.type.spec.tableRole !== 'row') {
              hover = null;
              return false;
            }
            const height =
              typeof rowNode.attrs.height === 'number'
                ? (rowNode.attrs.height as number)
                : Math.round(info.rect.height);
            dragging = { startY: event.clientY, startHeight: height, rowPos: info.rowPos };
            viewRef = view;
            window.addEventListener('mousemove', onDragMove);
            window.addEventListener('mouseup', onDragEnd);
            event.preventDefault();
            return true;
          } catch (err) {
            return false;
          }
        },
      },
    },
  });
});