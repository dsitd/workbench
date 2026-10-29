import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Pin, PinOff } from 'lucide-react';
import type { Session } from '../../shared/types';

export function ChatMenu({ chat, onRename, onPin, onArchive, onRestore }: {
  chat: Session; onRename: () => void; onPin: () => void; onArchive: () => void; onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const busy = chat.status === 'running' || chat.status === 'approval';
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    setPosition({ left: Math.min(bounds.left, window.innerWidth - 205), top: Math.min(bounds.bottom + 5, window.innerHeight - 155) });
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', close); window.addEventListener('resize', resize); window.addEventListener('scroll', resize, true);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', resize); window.removeEventListener('scroll', resize, true); };
  }, [open]);
  const action = (callback: () => void) => { setOpen(false); trigger.current?.focus(); callback(); };
  return <><button ref={trigger} className="icon-button chat-menu-trigger" data-testid={`chat-menu-${chat.id}`} aria-label={`Действия с чатом ${chat.title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={14} /></button>{open && createPortal(<div className="chat-action-menu" ref={menu} role="menu" aria-label="Действия с чатом" style={position} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if (event.key === 'Tab') setOpen(false);
  }}>
    <button role="menuitem" data-testid="chat-rename" onClick={() => action(onRename)}><Pencil size={14} />Переименовать</button>
    <button role="menuitem" data-testid="chat-pin" onClick={() => action(onPin)}>{chat.pinned ? <PinOff size={14} /> : <Pin size={14} />}{chat.pinned ? 'Открепить' : 'Закрепить'}</button>
    {chat.archivedAt ? <button role="menuitem" data-testid="chat-restore" onClick={() => action(onRestore)}><ArchiveRestore size={14} />Восстановить</button> : <button role="menuitem" data-testid="chat-archive" disabled={busy} title={busy ? 'Сначала остановите агента' : undefined} onClick={() => action(onArchive)}><Archive size={14} />Архивировать</button>}
  </div>, document.body)}</>;
}
