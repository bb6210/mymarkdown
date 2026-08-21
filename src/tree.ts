import type { FileEntry, MarkdownApi } from '../shared/api';

export interface TreeCallbacks {
  onOpenFile(path: string): void;
  onNewFile(dir: string, name: string): Promise<string | null>;
  onNewFolder(dir: string, name: string): Promise<string | null>;
  onRename(node: FileEntry, newName: string): Promise<boolean>;
  onDeleteFile(node: FileEntry): void;
  onContextMenu(node: FileEntry, x: number, y: number): void;
}

interface TreeNode extends FileEntry {
  children: TreeNode[] | null;
  expanded: boolean;
  active: boolean;
}

export class FileTree {
  private root: TreeNode | null = null;
  private container: HTMLElement;

  constructor(
    container: HTMLElement,
    private api: MarkdownApi,
    private callbacks: TreeCallbacks,
  ) {
    this.container = container;
    this.container.addEventListener('click', (event) => this.handleClick(event));
    this.container.addEventListener('contextmenu', (event) => this.handleContextMenu(event));
  }

  async setRoot(dir: string): Promise<void> {
    this.root = {
      name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
      path: dir,
      isDir: true,
      children: null,
      expanded: true,
      active: false,
    };
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.root) return;
    await this.loadNode(this.root, true);
    await this.reloadExpanded(this.root);
    this.render();
  }

  firstMarkdownFile(): string | null {
    const walk = (nodes: TreeNode[]): string | null => {
      for (const node of nodes) {
        if (!node.isDir && !node.isImage) return node.path;
        const found = walk(node.children ?? []);
        if (found) return found;
      }
      return null;
    };
    return this.root ? walk(this.root.children ?? []) : null;
  }

  setActive(path: string): void {
    const walk = (nodes: TreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.path === path) {
          node.active = true;
          return true;
        }
        node.active = false;
        if (walk(node.children ?? [])) return true;
      }
      return false;
    };
    if (this.root) walk(this.root.children ?? []);
    // 只切换类名，避免整棵树重绘导致的卡顿
    const items = this.container.querySelectorAll<HTMLElement>('li.tree-item.active');
    for (const item of items) item.classList.remove('active');
    const li = this.findLi(path);
    if (li) li.classList.add('active');
  }

  startRename(node: FileEntry): void {
    const li = this.findLi(node.path);
    if (!li) return;
    const nameEl = li.querySelector<HTMLElement>('.tree-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'inline-input';
    input.value = node.name;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const value = input.value.trim();
      if (commit && value && value !== node.name) {
        void this.callbacks.onRename(node, value).then((ok) => {
          if (!ok) this.render();
        });
      } else {
        this.render();
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  insertNewFileInput(dirPath: string): void {
    this.insertNewItemInput(dirPath, 'file');
  }

  insertNewFolderInput(dirPath: string): void {
    this.insertNewItemInput(dirPath, 'folder');
  }

  private insertNewItemInput(dirPath: string, kind: 'file' | 'folder'): void {
    const node = this.findNode(dirPath);
    if (!node || !node.isDir) return;
    if (!node.expanded) node.expanded = true;
    this.render();
    const li = this.findLi(dirPath);
    if (!li) return;
    const ul = li.querySelector<HTMLElement>('ul.tree-children');
    if (!ul) return;
    const item = document.createElement('li');
    item.className = 'tree-item tree-input-row';
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = '36px';
    const input = document.createElement('input');
    input.className = 'inline-input';
    input.value = kind === 'folder' ? '新建文件夹' : '未命名.md';
    input.spellcheck = false;
    row.appendChild(input);
    item.appendChild(row);
    ul.prepend(item);
    input.focus();
    input.select();
    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const value = input.value.trim();
      if (commit && value) {
        const createdPromise =
          kind === 'folder'
            ? this.callbacks.onNewFolder(dirPath, value)
            : this.callbacks.onNewFile(dirPath, value);
        void createdPromise.then((created) => {
          if (created) {
            void this.refresh().then(() => {
              if (kind === 'file') this.callbacks.onOpenFile(created);
            });
          } else {
            this.render();
          }
        });
      } else {
        this.render();
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  private async loadNode(node: TreeNode, force: boolean): Promise<void> {
    if (node.children && !force) return;
    const entries = await this.api.readDir(node.path);
    node.children = entries.map((entry): TreeNode => {
      const prev = node.children?.find((c) => c.path === entry.path);
      return prev ? { ...prev, ...entry } : { ...entry, children: null, expanded: false, active: false };
    });
  }

  private async reloadExpanded(node: TreeNode): Promise<void> {
    for (const child of node.children ?? []) {
      if (child.isDir && child.expanded) {
        await this.loadNode(child, true);
        await this.reloadExpanded(child);
      }
    }
  }

  private findNode(path: string, nodes?: TreeNode[]): TreeNode | null {
    if (nodes === undefined && this.root) {
      if (this.root.path === path) return this.root;
      return this.findNode(path, this.root.children ?? undefined);
    }
    const list = nodes;
    if (!list) return null;
    for (const node of list) {
      if (node.path === path) return node;
      if (node.isDir && node.children) {
        const found = this.findNode(path, node.children);
        if (found) return found;
      }
    }
    return null;
  }

  private findLi(path: string): HTMLElement | null {
    const items = this.container.querySelectorAll<HTMLElement>('li.tree-item');
    for (const item of items) {
      if (item.dataset.path === path) return item;
    }
    return null;
  }

  private handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const li = target.closest<HTMLElement>('li.tree-item');
    if (!li) return;
    const path = li.dataset.path;
    if (!path) return;
    const node = this.findNode(path);
    if (!node) return;
    if (node.isDir) {
      // 点文件夹本身与点箭头一致：展开/收起
      node.expanded = !node.expanded;
      if (node.expanded && !node.children) {
        void this.loadNode(node, false).then(() => this.render());
      } else {
        // 子节点已加载：直接切换展开状态，避免整棵树重绘
        const ul = li.querySelector<HTMLElement>('ul.tree-children');
        if (ul) {
          ul.classList.toggle('hidden', !node.expanded);
          const arrow = li.querySelector<HTMLElement>('.tree-arrow');
          if (arrow) {
            arrow.textContent = node.expanded ? '▾' : '▸';
            arrow.classList.toggle('expanded', node.expanded);
          }
        } else {
          this.render();
        }
      }
    } else {
      this.callbacks.onOpenFile(path);
    }
  }

  private handleContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const li = target.closest<HTMLElement>('li.tree-item');
    if (!li) return;
    const path = li.dataset.path;
    if (!path) return;
    const node = this.findNode(path);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.onContextMenu(node, event.clientX, event.clientY);
  }

  private render(): void {
    // 保留滚动位置，避免重绘后跳回顶部
    const scrollTop = this.container.scrollTop;
    this.container.innerHTML = '';
    if (!this.root) return;
    this.container.appendChild(this.renderNode(this.root, 0));
    this.container.scrollTop = scrollTop;
  }

  private renderNode(node: TreeNode, depth: number): HTMLElement {
    const li = document.createElement('li');
    li.className =
      'tree-item' +
      (node.isDir ? ' tree-dir' : ' tree-file') +
      (node.active ? ' active' : '');
    li.dataset.path = node.path;
    li.dataset.type = node.isDir ? 'dir' : 'file';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = `${6 + depth * 16}px`;

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow' + (node.isDir && node.expanded ? ' expanded' : '');
    arrow.textContent = node.isDir ? (node.expanded ? '▾' : '▸') : '';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.isDir ? '📁' : '📄';

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    name.title = node.path;

    row.append(arrow, icon, name);
    li.appendChild(row);

    if (node.isDir) {
      const ul = document.createElement('ul');
      ul.className = 'tree-children' + (node.expanded ? '' : ' hidden');
      for (const child of node.children ?? []) {
        ul.appendChild(this.renderNode(child, depth + 1));
      }
      li.appendChild(ul);
    }

    return li;
  }
}