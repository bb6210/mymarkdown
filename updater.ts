import type { MarkdownApi, UpdateEvent } from '../shared/api';

export function checkForUpdates(api: MarkdownApi): void {
  void api.checkForUpdates();
}

export function initUpdater(api: MarkdownApi): void {
  let card: HTMLDivElement | null = null;
  let hideTimer: number | undefined;

  const hide = (): void => {
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    hideTimer = undefined;
    if (card && card.parentElement) card.parentElement.removeChild(card);
    card = null;
  };

  const baseStyle: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    background: 'rgba(24,26,32,0.95)',
    color: '#f2f3f5',
    borderRadius: '10px',
    padding: '14px 16px',
    maxWidth: '340px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
    font: '13px/1.5 "Microsoft YaHei", system-ui, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  };

  function show(
    message: string,
    actions: Array<{ label: string; primary?: boolean; onClick: () => void }> = [],
    duration?: number,
  ): void {
    if (!card) {
      card = document.createElement('div');
      Object.assign(card.style, baseStyle);
      document.body.appendChild(card);
    }
    card.innerHTML = '';
    const msg = document.createElement('div');
    msg.textContent = message;
    card.appendChild(msg);
    if (actions.length > 0) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.style.cssText = action.primary
          ? 'padding:5px 12px;border:none;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;font-size:12px;'
          : 'padding:5px 12px;border:none;border-radius:6px;background:rgba(255,255,255,0.14);color:#e5e7eb;cursor:pointer;font-size:12px;';
        btn.addEventListener('click', action.onClick);
        row.appendChild(btn);
      }
      card.appendChild(row);
    }
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    hideTimer = duration === undefined ? undefined : window.setTimeout(hide, duration);
  }

  api.onUpdate((event: UpdateEvent) => {
    switch (event.type) {
      case 'checking':
        show('正在检查更新…');
        break;
      case 'available':
        show(`发现新版本 v${event.version ?? ''}`, [
          { label: '立即更新', primary: true, onClick: () => void api.downloadUpdate() },
          { label: '稍后', onClick: hide },
        ]);
        break;
      case 'downloading':
        show(`正在下载更新… ${event.percent ?? 0}%`);
        break;
      case 'downloaded':
        show(`新版本 v${event.version ?? ''} 已下载，重启后生效`, [
          { label: '立即重启', primary: true, onClick: () => void api.quitAndInstall() },
          { label: '稍后', onClick: hide },
        ]);
        break;
      case 'not-available':
        show('已是最新版本', [], 2000);
        break;
      case 'error':
        show(`更新失败：${event.message ?? '未知错误'}`, [{ label: '重试', primary: true, onClick: () => checkForUpdates(api) }], 5000);
        break;
    }
  });
}