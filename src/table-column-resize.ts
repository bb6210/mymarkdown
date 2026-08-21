import { $prose } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { TableMap, columnResizingPluginKey, tableEditingKey } from '@milkdown/kit/prose/tables';

/* ---------- 列宽拖拽（自定义） ----------
 * 规则：
 *  1) 只有列与列之间的分隔线可拖；表格最左/最右边框不参与。
 *  2) 抓分隔线 = 调整左侧那一列。
 *  3) 表格总宽保持不变：右侧相邻列等量吸收差值（右边缘不动）。
 * 实现：开始拖拽前把所有列的真实渲染宽度写入 colwidth（表格转为固定
 * 像素宽），拖拽过程中只改 colgroup 做实时预览，松手时把新宽度写回文档。 */

const COL_EDGE = 5;
const MIN_COL = 25;

type DragState = {
  startX: number;
  targetCol: number;
  adjCol: number;
  widths: number[];
  tableNode: import('@milkdown/kit/prose/model').Node;
  start: number;
  map: TableMap;
  colgroup: HTMLElement;
  view: EditorView;
};

function domCellAround(target: EventTarget | null): HTMLElement | null {
  let el = target as HTMLElement | null;
  while (el && el.nodeName !== 'TD' && el.nodeName !== 'TH') {
    if (el.classList && el.classList.contains('ProseMirror')) return null;
    el = el.parentElement;
  }
  return el;
}

export const columnResizeFixPlugin = $prose(() => {
  let drag: DragState | null = null;

  function cellPos(view: EditorView, el: HTMLElement): number | null {
    const pos = view.posAtDOM(el, 0);
    if (pos == null) return null;
    const $pos = view.state.doc.resolve(pos);
    for (let d = $pos.depth; d > 0; d--) {
      const role = $pos.node(d).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') return $pos.before(d);
    }
    return null;
  }

  function handleTarget(view: EditorView, event: MouseEvent): { pos: number; branch: string } | null {
    const cell = domCellAround(event.target);
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    let target: HTMLElement;
    let branch: string;
    if (rect.right - event.clientX <= COL_EDGE) {
      target = cell;
      branch = 'right';
    } else if (event.clientX - rect.left <= COL_EDGE) {
      const prev = cell.previousElementSibling as HTMLElement | null;
      if (prev && (prev.nodeName === 'TD' || prev.nodeName === 'TH')) {
        target = prev;
        branch = 'left-prev';
      } else {
        return null; // 表格最左边缘：不参与列宽调整
      }
    } else {
      return null;
    }
    const pos = cellPos(view, target);
    if (pos == null) return null;
    if (branch === 'right') {
      // 表格最右边缘：不参与列宽调整
      const $cell = view.state.doc.resolve(pos);
      const table = $cell.node(-1);
      if (!table) return null;
      const map = TableMap.get(table);
      const info = map.findCell($cell.pos - $cell.start(-1));
      if (info.right >= map.width) return null;
    }
    return { pos, branch };
  }

  function setHandle(view: EditorView, pos: number): void {
    const st = columnResizingPluginKey.getState(view.state);
    if (st && st.activeHandle === pos) return;
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: pos }));
  }

  function clearHandle(view: EditorView): void {
    const st = columnResizingPluginKey.getState(view.state);
    if (st && st.activeHandle > -1) {
      view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
    }
  }

  function normalizeColumns(view: EditorView, cell: number): number[] | null {
    try {
      const $cell = view.state.doc.resolve(cell);
      const table = $cell.node(-1);
      if (!table) return null;
      const map = TableMap.get(table);
      const start = $cell.start(-1);
      const seen = new Set<number>();
      const relCells: number[] = [];
      for (const p of map.map) {
        if (seen.has(p)) continue;
        seen.add(p);
        relCells.push(p);
      }
      const colWidths = new Array<number>(map.width).fill(0);
      for (const rel of relCells) {
        const node = table.nodeAt(rel);
        if (!node || (node.attrs.colspan || 1) !== 1) continue;
        const info = map.findCell(rel);
        const dom = view.domAtPos(start + rel);
        const el = dom.node.childNodes[dom.offset] as HTMLElement | undefined;
        if (el && el.offsetWidth > 0) colWidths[info.left] = Math.round(el.offsetWidth);
      }
      if (colWidths.some((w) => w <= 0)) return null;
      const tr = view.state.tr;
      for (const rel of relCells) {
        const node = table.nodeAt(rel);
        if (!node) continue;
        const info = map.findCell(rel);
        const colspan = info.right - info.left;
        const colwidth: number[] = [];
        for (let k = 0; k < colspan; k++) colwidth.push(colWidths[info.left + k] ?? 0);
        tr.setNodeMarkup(start + rel, null, { ...node.attrs, colwidth });
      }
      view.dispatch(tr);
      return colWidths;
    } catch {
      return null;
    }
  }

  function startDrag(view: EditorView, event: MouseEvent, cellPos: number, widths: number[]): void {
    const $cell = view.state.doc.resolve(cellPos);
    const tableNode = $cell.node(-1);
    if (!tableNode) return;
    const map = TableMap.get(tableNode);
    const start = $cell.start(-1);
    const info = map.findCell($cell.pos - start);
    const targetCol = info.right - 1;
    const adjCol = targetCol + 1 < map.width ? targetCol + 1 : -1;
    let dom = view.domAtPos(start).node as HTMLElement;
    while (dom && dom.nodeName !== 'TABLE') dom = dom.parentNode as HTMLElement;
    if (!dom) return;
    const colgroup = dom.firstChild as HTMLElement | null;
    if (!colgroup || colgroup.nodeName !== 'COLGROUP') return;
    drag = { startX: event.clientX, targetCol, adjCol, widths: widths.slice(), tableNode, start, map, colgroup, view };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: event.clientX, startWidth: widths[targetCol] } }));
  }

  function onDragMove(e: MouseEvent): void {
    if (!drag) return;
    try {
      const dx = e.clientX - drag.startX;
      const targetW = Math.max(MIN_COL, Math.round(drag.widths[drag.targetCol] + dx));
      const used = targetW - drag.widths[drag.targetCol];
      const adjW = drag.adjCol >= 0 ? Math.max(MIN_COL, Math.round(drag.widths[drag.adjCol] - used)) : null;
      const cols = drag.colgroup.children;
      const t = cols[drag.targetCol] as HTMLElement | undefined;
      if (t) t.style.width = targetW + 'px';
      if (adjW != null) {
        const a = cols[drag.adjCol] as HTMLElement | undefined;
        if (a) a.style.width = adjW + 'px';
      }
    } catch {
      endDrag();
    }
  }

  function endDrag(): void {
    if (!drag) return;
    const { view, map, start, targetCol, adjCol, tableNode, colgroup } = drag;
    try {
      const cols = colgroup.children;
      const targetW = Math.round(parseFloat((cols[targetCol] as HTMLElement).style.width || '0'));
      const adjW = adjCol >= 0 ? Math.round(parseFloat((cols[adjCol] as HTMLElement).style.width || '0')) : null;
      const tr = view.state.tr;
      const seen = new Set<number>();
      for (const rel of map.map) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const node = tableNode.nodeAt(rel);
        if (!node) continue;
        const info = map.findCell(rel);
        const colwidth = (node.attrs.colwidth && node.attrs.colwidth.slice()) || [];
        let changed = false;
        if (targetCol >= info.left && targetCol < info.right) {
          colwidth[targetCol - info.left] = targetW;
          changed = true;
        }
        if (adjCol >= 0 && adjCol >= info.left && adjCol < info.right) {
          colwidth[adjCol - info.left] = adjW as number;
          changed = true;
        }
        if (changed) tr.setNodeMarkup(start + rel, null, { ...node.attrs, colwidth });
      }
      if (tr.docChanged) view.dispatch(tr);
      view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }));
      clearHandle(view);
    } catch {
      // 忽略异常，保证拖拽状态能清理
    }
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    drag = null;
  }

  function onDragEnd(): void {
    endDrag();
  }

  return new Plugin({
    key: new PluginKey<unknown>('mm-column-resize-fix'),
    props: {
      handleDOMEvents: {
        mousemove: (view, event) => {
          if (!view.editable) return false;
          if (drag) return true;
          const col = columnResizingPluginKey.getState(view.state);
          if (col && col.dragging) return false;
          if (tableEditingKey.getState(view.state) != null) return false;
          if (!domCellAround(event.target)) return false;
          try {
            const target = handleTarget(view, event);
            if (target != null) setHandle(view, target.pos);
            else clearHandle(view);
            return true;
          } catch {
            return false;
          }
        },
        mousedown: (view, event) => {
          const st = columnResizingPluginKey.getState(view.state);
          if (st && st.activeHandle > -1 && !st.dragging) {
            const widths = normalizeColumns(view, st.activeHandle);
            if (widths) {
              startDrag(view, event, st.activeHandle, widths);
              event.preventDefault();
              return true; // 阻止内置列宽插件自己拖拽
            }
          }
          return false;
        },
      },
    },
  });
});