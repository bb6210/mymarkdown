import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view';
import { highlightCode, LANGUAGES } from './syntax-highlight';

function makeEl(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

// copy helper: prefer navigator.clipboard, fall back to execCommand for non-secure contexts
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}


// 把高亮结果按“标签外换行”切成行，逐行包 div，实现隔行异色
// （切分时避开 <span> 标签本身，防止切断标签）
function buildZebra(highlighted: string): string {
  const lines: string[] = [];
  let current = '';
  let inTag = false;
  for (let i = 0; i < highlighted.length; i++) {
    const ch = highlighted[i];
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    if (ch === '\n' && !inTag) {
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  lines.push(current);
  return lines
    .map((line, index) => '<div class="mm-code-line' + (index % 2 === 0 ? ' alt' : '') + '">' + (line || '&#8203;') + '</div>')
    .join('');
}

/* 自定义代码块视图：左上角语言下拉框 + 语法高亮（背景层渲染高亮，编辑层文字透明叠加） */
export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private head: HTMLElement;
  private langButton!: HTMLButtonElement;
  private langLabel!: HTMLElement;
  private langPop!: HTMLDivElement;
  private langOpen = false;
  private copyButton!: HTMLButtonElement;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private backdrop: HTMLElement;
  private scrollTarget: HTMLElement | null = null;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    const wrapper = makeEl('div', 'mm-code');
    this.dom = wrapper;

    this.head = makeEl('div', 'mm-code-head');
    this.buildLangPicker();
    this.head.appendChild(this.langButton);
    this.buildCopyButton();
    wrapper.appendChild(this.head);

    const body = makeEl('div', 'mm-code-body');
    this.backdrop = makeEl('pre', 'mm-code-backdrop');
    this.backdrop.setAttribute('aria-hidden', 'true');
    const editPre = makeEl('pre', 'mm-code-edit');
    editPre.addEventListener('scroll', () => {
      this.syncBackdrop();
    });
    this.contentDOM = editPre;
    body.appendChild(this.backdrop);
    body.appendChild(editPre);
    wrapper.appendChild(body);

    this.render();
  }

  /* ---------- 自绘语言下拉框（原生 select 弹层在 Windows 上不受主题控制） ---------- */

  private buildLangPicker(): void {
    this.langButton = document.createElement('button');
    this.langButton.type = 'button';
    this.langButton.className = 'mm-code-lang';
    this.langButton.setAttribute('aria-haspopup', 'listbox');
    this.langLabel = document.createElement('span');
    this.langLabel.className = 'mm-code-lang-label';
    const arrow = document.createElement('span');
    arrow.className = 'mm-code-lang-arrow';
    this.langButton.append(this.langLabel, arrow);

    this.langPop = document.createElement('div');
    this.langPop.className = 'mm-code-lang-pop';
    this.langPop.setAttribute('role', 'listbox');
    this.langPop.hidden = true;

    this.langButton.addEventListener('mousedown', (e) => e.preventDefault());
    this.langButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleLangPop();
    });
    this.langButton.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeLangPop();
    });
    this.langPop.addEventListener('mousedown', (e) => e.preventDefault());
    this.langPop.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.mm-code-lang-item') as HTMLButtonElement | null;
      if (item && item.dataset.lang !== undefined) {
        this.setLanguage(item.dataset.lang);
        this.closeLangPop();
      }
    });
    document.addEventListener('mousedown', this.onDocMouseDown);
  }

  private onDocMouseDown = (e: MouseEvent): void => {
    if (!this.langOpen) return;
    const target = e.target as Node | null;
    if (target && (this.langButton.contains(target) || this.langPop.contains(target))) return;
    this.closeLangPop();
  };

  private currentLangKey(): string {
    const language = String(this.node.attrs.language ?? '');
    return language.toLowerCase() || 'text';
  }

  private toggleLangPop(): void {
    if (this.langOpen) this.closeLangPop();
    else this.openLangPop();
  }

  private rebuildLangItems(): void {
    this.langPop.replaceChildren();
    const current = this.currentLangKey();
    const addItem = (value: string, label: string): void => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mm-code-lang-item';
      item.dataset.lang = value;
      item.textContent = label;
      if (value === current) item.classList.add('active');
      this.langPop.appendChild(item);
    };
    for (const lang of LANGUAGES) addItem(lang.value, lang.label);
    if (current !== 'text' && !LANGUAGES.some((l) => l.value === current)) {
      addItem(current, current);
    }
  }

  private openLangPop(): void {
    this.rebuildLangItems();
    const rect = this.langButton.getBoundingClientRect();
    const estHeight = Math.min(280, 24 + this.langPop.children.length * 26);
    this.langPop.style.position = 'fixed';
    this.langPop.style.left = rect.left + 'px';
    this.langPop.style.minWidth = Math.max(170, rect.width) + 'px';
    if (rect.bottom + 4 + estHeight > window.innerHeight) {
      this.langPop.style.top = Math.max(8, rect.top - estHeight - 4) + 'px';
    } else {
      this.langPop.style.top = rect.bottom + 4 + 'px';
    }
    this.langPop.hidden = false;
    document.body.appendChild(this.langPop);
    this.langOpen = true;
    this.scrollTarget = this.dom.closest('.editor-wrap');
    if (this.scrollTarget) this.scrollTarget.addEventListener('scroll', this.onScrollClose, true);
    const active = this.langPop.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  private closeLangPop(): void {
    if (!this.langOpen) return;
    this.langOpen = false;
    this.langPop.hidden = true;
    if (this.langPop.parentNode === document.body) document.body.removeChild(this.langPop);
    if (this.scrollTarget) {
      this.scrollTarget.removeEventListener('scroll', this.onScrollClose, true);
      this.scrollTarget = null;
    }
  }

  private onScrollClose = (): void => {
    this.closeLangPop();
  };

  private setLanguage(value: string): void {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const language = value === 'text' ? '' : value;
    if (String(this.node.attrs.language ?? '') === language) return;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'language', language));
    this.view.focus();
  }

  /* ---------- 渲染与生命周期 ---------- */

  private buildCopyButton(): void {
    this.copyButton = document.createElement('button');
    this.copyButton.type = 'button';
    this.copyButton.className = 'mm-code-copy';
    this.copyButton.setAttribute('aria-label', 'copy code');
    this.copyButton.textContent = '复制';
    this.copyButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.copyCode();
    });
    this.head.appendChild(this.copyButton);
  }

  private async copyCode(): Promise<void> {
    const ok = await copyTextToClipboard(this.node.textContent);
    this.copyButton.textContent = ok ? '已复制' : '复制失败';
    this.copyButton.classList.toggle('copied', ok);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copyButton.textContent = '复制';
      this.copyButton.classList.remove('copied');
    }, 1200);
  }

  // 背景层与编辑层滚动同步：用 transform 平移，重建 innerHTML 也不会丢位置
  private syncBackdrop(): void {
    const edit = this.contentDOM;
    this.backdrop.style.transform = 'translate(' + -edit.scrollLeft + 'px,' + -edit.scrollTop + 'px)';
  }

  private render(): void {
    const key = this.currentLangKey();
    const known = LANGUAGES.find((l) => l.value === key);
    this.langLabel.textContent = known ? known.label : key;
    this.backdrop.innerHTML = buildZebra(highlightCode(this.node.textContent, key));
    this.syncBackdrop();
    if (this.langOpen) this.rebuildLangItems();
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== 'code_block') return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('mm-code-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('mm-code-selected');
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (!this.contentDOM.contains(mutation.target)) return true;
    return false;
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    if (target instanceof Element && (this.head.contains(target) || this.langPop.contains(target))) return true;
    return false;
  }

  destroy(): void {
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.closeLangPop();
    document.removeEventListener('mousedown', this.onDocMouseDown);
  }
}
