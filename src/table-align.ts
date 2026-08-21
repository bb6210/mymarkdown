import { $nodeSchema } from '@milkdown/kit/utils';
import type { Node } from '@milkdown/kit/prose/model';

/* ---------- 表格单元格对齐扩展 ----------
 * 在 GFM 表格基础上给单元格增加 verticalAlign（上/中/下）属性，
 * alignment（左/中/右）沿用 GFM 表头对齐行，两者都写入 td/th 的 style。
 */

type CellDom = HTMLElement | string;

function parseCellAttrs(dom: CellDom): Record<string, unknown> {
  if (typeof dom === 'string') return {};
  const colspan = Math.max(1, Number(dom.getAttribute('colspan') || 1));
  const rowspan = Math.max(1, Number(dom.getAttribute('rowspan') || 1));
  const colwidthAttr = dom.getAttribute('data-colwidth');
  const widths =
    colwidthAttr && /^\d+(,\d+)*$/.test(colwidthAttr) ? colwidthAttr.split(',').map(Number) : null;
  return {
    colspan,
    rowspan,
    colwidth: widths && widths.length === colspan ? widths : null,
    alignment: dom.style.textAlign || 'left',
    verticalAlign: dom.style.verticalAlign || 'top',
  };
}

function renderCellAttrs(node: Node): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
  if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
  if (node.attrs.colwidth) attrs['data-colwidth'] = (node.attrs.colwidth as number[]).join(',');
  const style: string[] = [];
  if (node.attrs.alignment && node.attrs.alignment !== 'left') {
    style.push('text-align:' + node.attrs.alignment);
  }
  if (node.attrs.verticalAlign && node.attrs.verticalAlign !== 'top') {
    style.push('vertical-align:' + node.attrs.verticalAlign);
  }
  if (style.length) attrs.style = style.join(';');
  return attrs;
}

const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
  alignment: { default: 'left' },
  verticalAlign: { default: 'top' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RemarkState = any;

export const tableCellAlignSchema = $nodeSchema('table_cell', () => ({
  content: 'paragraph',
  tableRole: 'cell',
  isolating: true,
  group: 'block',
  attrs: cellAttrs,
  disableDropCursor: true,
  parseDOM: [{ tag: 'td', getAttrs: parseCellAttrs }],
  toDOM: (node: Node) => ['td', renderCellAttrs(node), 0],
  parseMarkdown: {
    match: (node: { type: string; isHeader?: boolean }) => node.type === 'tableCell' && !node.isHeader,
    runner: (state: RemarkState, node: any, type: unknown) => {
      state.openNode(type, {
        alignment: node.align || 'left',
        verticalAlign: node.verticalAlign || 'top',
        colspan: Math.max(1, Number(node.colspan) || 1),
        rowspan: Math.max(1, Number(node.rowspan) || 1),
        colwidth: Array.isArray(node.colwidth) ? node.colwidth : null,
      }).openNode(state.schema.nodes.paragraph).next(node.children).closeNode().closeNode();
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === 'table_cell',
    runner: (state: RemarkState, node: Node) => {
      state.openNode('tableCell').next(node.content).closeNode();
    },
  },
}));

export const tableHeaderAlignSchema = $nodeSchema('table_header', () => ({
  content: 'paragraph',
  tableRole: 'header_cell',
  isolating: true,
  group: 'block',
  attrs: cellAttrs,
  disableDropCursor: true,
  parseDOM: [{ tag: 'th', getAttrs: parseCellAttrs }],
  toDOM: (node: Node) => ['th', renderCellAttrs(node), 0],
  parseMarkdown: {
    match: (node: { type: string; isHeader?: boolean }) => node.type === 'tableCell' && !!node.isHeader,
    runner: (state: RemarkState, node: any, type: unknown) => {
      state.openNode(type, {
        alignment: node.align || 'left',
        verticalAlign: node.verticalAlign || 'top',
        colspan: Math.max(1, Number(node.colspan) || 1),
        rowspan: Math.max(1, Number(node.rowspan) || 1),
        colwidth: Array.isArray(node.colwidth) ? node.colwidth : null,
      });
      state.openNode(state.schema.nodes.paragraph);
      state.next(node.children);
      state.closeNode();
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === 'table_header',
    runner: (state: RemarkState, node: Node) => {
      state.openNode('tableCell');
      state.next(node.content);
      state.closeNode();
    },
  },
}));
