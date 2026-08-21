import { $nodeSchema, $remark } from '@milkdown/kit/utils';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import type { Node } from '@milkdown/kit/prose/model';
import { domToMdast, type MdAstNode } from './paragraph-style';
import { getSettings } from './settings';

/* ---------- 表格尺寸持久化（Typora 风格 HTML 表格） ----------
 * GFM 的 | a | b | 纯文本表格无法携带列宽(colwidth)与行高(height)。
 * 方案：表格一旦有自定义列宽/行高，保存时整表以 HTML <table> 形式写进 .md
 * （单元格 data-colwidth、行 style="height:…px"、可选 <colgroup>），
 * 打开时由 $remark 把 HTML 表格还原成表格节点并恢复尺寸。
 * 没有自定义尺寸的表格保持 GFM 纯文本输出，源码不受影响。
 * 兼容读取旧版 <!--mm-table:…--> 注释格式（不再写出）。
 */

type RemarkState = any;

function normalizeNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parsePx(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)\s*px$/i.exec(value.trim());
  return m ? Math.round(Number(m[1])) : null;
}

/** 表格是否存在自定义列宽/行高（决定是否以 HTML 形式保存） */
export function tableHasCustomSizes(node: Node): boolean {
  let has = false;
  node.forEach((row) => {
    if (normalizeNumber(row.attrs.height) != null) {
      has = true;
      return;
    }
    row.forEach((cell) => {
      const cw = cell.attrs.colwidth as unknown;
      if (Array.isArray(cw) && cw.some((w) => typeof w === 'number' && w > 0)) has = true;
    });
  });
  return has;
}

/** 由表头行推导逐列宽度，输出 <colgroup>（仅当表头各单元格列宽完整时） */
function buildColgroup(node: Node): string {
  const firstRow = node.content.firstChild;
  if (!firstRow) return '';
  const widths: number[] = [];
  for (let i = 0; i < firstRow.childCount; i++) {
    const cell = firstRow.child(i);
    const colspan = Math.max(1, Number(cell.attrs.colspan) || 1);
    const cw = cell.attrs.colwidth as unknown;
    if (!Array.isArray(cw) || cw.length !== colspan) return '';
    for (const w of cw) {
      const n = Number(w);
      if (!Number.isFinite(n) || n <= 0) return '';
      widths.push(Math.round(n));
    }
  }
  if (widths.length === 0) return '';
  return '<colgroup>' + widths.map((w) => '<col style="width:' + w + 'px">').join('') + '</colgroup>';
}

/** 把 PM 表格节点序列化为 HTML 表格 */
export function tableNodeToHtml(node: Node): string {
  const fragment = DOMSerializer.fromSchema(node.type.schema).serializeFragment(node.content);
  const container = document.createElement('div');
  container.appendChild(fragment);
  return '<table>' + buildColgroup(node) + container.innerHTML + '</table>';
}

/* ---------- 解析：HTML 表格 -> mdast 表格节点 ---------- */

const TABLE_HTML_RE = /<table\b[\s\S]*?<\/table>/i;

function parseColgroupWidths(tableEl: Element): number[] {
  const widths: number[] = [];
  const colgroup = Array.from(tableEl.children).find((el) => el.tagName === 'COLGROUP');
  if (!colgroup) return widths;
  for (const col of Array.from(colgroup.children)) {
    if (col.tagName !== 'COL') continue;
    const w = parsePx((col as HTMLElement).style.width) ?? parsePx(col.getAttribute('width'));
    if (w == null || w <= 0) return [];
    widths.push(w);
  }
  return widths;
}

function htmlTableToMdast(value: string): MdAstNode | null {
  const m = TABLE_HTML_RE.exec(value);
  if (!m) return null;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = m[0];
  const tableEl = wrapper.querySelector('table');
  if (!tableEl) return null;
  const colWidths = parseColgroupWidths(tableEl);
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (rows.length === 0) return null;
  const children: MdAstNode[] = [];
  const align: Array<string | null> = [];
  rows.forEach((tr, rowIndex) => {
    const el = tr as HTMLElement;
    const isHeader =
      tr.hasAttribute('data-is-header') ||
      !!tr.querySelector('th') ||
      tr.parentElement?.tagName === 'THEAD';
    const height = parsePx(el.style.height);
    const rowNode: MdAstNode = { type: 'tableRow', isHeader, children: [] };
    if (height != null) rowNode.height = height;
    const cells = Array.from(tr.querySelectorAll('th, td'));
    let colIndex = 0;
    cells.forEach((cellEl) => {
      const cellDom = cellEl as HTMLElement;
      const colspan = Math.max(1, Number(cellDom.getAttribute('colspan')) || 1);
      const rowspan = Math.max(1, Number(cellDom.getAttribute('rowspan')) || 1);
      const dataCw = cellDom.getAttribute('data-colwidth');
      let colwidth: number[] | null =
        dataCw && /^\d+(,\d+)*$/.test(dataCw) ? dataCw.split(',').map(Number) : null;
      if (colwidth && colwidth.length !== colspan) colwidth = null;
      if (!colwidth && colWidths.length) {
        const slice = colWidths.slice(colIndex, colIndex + colspan);
        if (slice.length === colspan && slice.every((w) => w > 0)) colwidth = slice;
      }
      const inline: MdAstNode[] = [];
      domToMdast(cellDom, inline);
      const cell: MdAstNode = {
        type: 'tableCell',
        isHeader: cellDom.tagName === 'TH',
        colspan,
        rowspan,
        children: inline,
      };
      if (colwidth) cell.colwidth = colwidth;
      cell.align = cellDom.style.textAlign || null;
      cell.verticalAlign = cellDom.style.verticalAlign || null;
      (rowNode.children as MdAstNode[]).push(cell);
      colIndex += colspan;
    });
    children.push(rowNode);
    if (rowIndex === 0) {
      let idx = 0;
      for (const cellEl of cells) {
        const cellDom = cellEl as HTMLElement;
        const colspan = Math.max(1, Number(cellDom.getAttribute('colspan')) || 1);
        for (let k = 0; k < colspan; k++) align.push(cellDom.style.textAlign || null);
        idx += colspan;
      }
    }
  });
  return { type: 'table', align, children };
}

/* ---------- 兼容旧版 <!--mm-table:…--> 注释 ---------- */

const MM_TABLE_COMMENT = /^<!--\s*mm-table:\s*(\{[\s\S]*?\})\s*-->\s*$/;

function applyLegacyComment(children: any[]): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!node) continue;
    // Milkdown 的 remarkHTMLTransformer 会把块级 HTML 包成 paragraph(html)，两种形态都兼容
    let htmlNode: any = null;
    if (node.type === 'html' && typeof node.value === 'string') htmlNode = node;
    else if (
      node.type === 'paragraph' &&
      Array.isArray(node.children) &&
      node.children.length === 1 &&
      node.children[0] &&
      node.children[0].type === 'html' &&
      typeof node.children[0].value === 'string'
    ) {
      htmlNode = node.children[0];
    }
    if (!htmlNode) continue;
    const m = MM_TABLE_COMMENT.exec(htmlNode.value.trim());
    if (!m) continue;
    const next = children[i + 1];
    if (next && next.type === 'table') {
      try {
        const data = JSON.parse(m[1]) as { rows?: unknown; cols?: unknown };
        const rows = Array.isArray(data.rows) ? data.rows : undefined;
        const cols = Array.isArray(data.cols) ? data.cols : undefined;
        next.children?.forEach((row: any, rowIndex: number) => {
          if (!row || row.type !== 'tableRow') return;
          const height = Array.isArray(rows) ? normalizeNumber(rows[rowIndex]) : null;
          if (height != null) row.height = height;
          const stored = Array.isArray(cols) ? cols[rowIndex] : undefined;
          if (!Array.isArray(stored)) return;
          const flat: Array<number | null> = [];
          for (const cw of stored) {
            if (Array.isArray(cw) && cw.length) {
              flat.push(...cw.map((w) => (typeof w === 'number' ? w : null)));
            } else {
              flat.push(null);
            }
          }
          let cellIndex = 0;
          row.children?.forEach((cell: any) => {
            if (!cell || cell.type !== 'tableCell') return;
            const colspan = Math.max(1, Number(cell.colspan) || 1);
            const slice = flat.slice(cellIndex, cellIndex + colspan);
            cellIndex += colspan;
            if (slice.length === colspan && slice.every((w) => typeof w === 'number')) {
              cell.colwidth = slice;
            }
          });
        });
      } catch {
        // 数据损坏时丢弃注释，避免在编辑区显示出来
      }
      children.splice(i, 1);
      i--;
    }
  }
}

function transformTree(children: any[]): void {
  applyLegacyComment(children);
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!node) continue;
    if (node.type === 'html' && typeof node.value === 'string') {
      const table = htmlTableToMdast(node.value);
      if (table) {
        children[i] = table;
        continue;
      }
    }
    // Milkdown 的 remarkHTMLTransformer 会把块级 HTML 包成 paragraph(html)，
    // 必须把表格从段落里“提”出来，否则 paragraph(table) 无法通过内容校验，整张表会被丢弃
    if (
      node.type === 'paragraph' &&
      Array.isArray(node.children) &&
      node.children.length === 1 &&
      node.children[0] &&
      node.children[0].type === 'html' &&
      typeof node.children[0].value === 'string'
    ) {
      const table = htmlTableToMdast(node.children[0].value);
      if (table) {
        children[i] = table;
        continue;
      }
    }
    if (Array.isArray(node.children)) transformTree(node.children);
  }
}

export function transformTableSizeComments(tree: any): void {
  if (Array.isArray(tree?.children)) transformTree(tree.children);
}

const tableSizeRemark = $remark('mm-table-size', () => {
  return () => (tree: any) => {
    transformTableSizeComments(tree);
  };
});

/* ---------- 表格 schema：解析 HTML 尺寸 / 序列化 HTML 表格 ---------- */

export const tableSizeSchema = $nodeSchema('table', () => ({
  content: 'table_header_row table_row+',
  tableRole: 'table',
  isolating: true,
  group: 'block',
  disableDropCursor: true,
  parseDOM: [{ tag: 'table' }],
  toDOM: () => ['table', ['tbody', 0]],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === 'table',
    runner: (state: RemarkState, node: any, type: unknown) => {
      const align = node.align as Array<string | null> | undefined;
      const children = (node.children ?? []).map((x: any, i: number) => ({
        ...x,
        align,
        isHeader: x.isHeader === true || i === 0,
      }));
      state.openNode(type);
      state.next(children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === 'table',
    runner: (state: RemarkState, node: Node) => {
      const firstLine = node.content.firstChild?.content;
      if (!firstLine) return;
      const align: Array<string | null> = [];
      firstLine.forEach((cell) => {
        align.push(cell.attrs.alignment);
      });
      if (getSettings().tableSizePersist && tableHasCustomSizes(node)) {
        state.addNode('html', undefined, tableNodeToHtml(node));
      } else {
        state.openNode('table', void 0, { align });
        state.next(node.content);
        state.closeNode();
      }
    },
  },
}));

export { tableSizeRemark };