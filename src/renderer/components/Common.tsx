import { Children, isValidElement, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import type { Attachment } from '../../shared/types';
import { api, sizeLabel } from '../api';

export function IconButton({ label, children, onClick, disabled, className = '', testId }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; testId?: string }) {
  return <button className={`icon-button ${className}`} data-testid={testId} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="Закрыть окно" onClick={onClose}><X size={18} /></IconButton></header>{children}</section></div>;
}
export function Busy({ text = 'Загрузка…' }: { text?: string }) { return <span className="busy" role="status" aria-live="polite" aria-label={text || 'Загрузка…'}><LoaderCircle size={15} className="spin" aria-hidden="true" />{text}</span>; }
export function ErrorNote({ text }: { text?: string | null }) { return text ? <div className="error-note" role="alert">{text}</div> : null; }
export function AttachmentImage({ id, attachment, onRemove }: { id: string; attachment?: Attachment; onRemove?: () => void }) {
  const [url, setUrl] = useState('');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { let active = true; api.resolveAttachment(id).then((value) => { if (active) setUrl(value); }).catch(() => {}); return () => { active = false; }; }, [id]);
  return <><div className={`attachment ${onRemove ? 'attachment-draft' : ''}`}>{url ? <button className="attachment-preview" aria-label={`Открыть ${attachment?.name || 'изображение'}`} onClick={() => setExpanded(true)}><img src={url} alt={attachment?.name || 'Прикреплённое изображение'} /></button> : <div className="attachment-loading"><LoaderCircle className="spin" size={18} /></div>}{attachment && <div className="attachment-label"><span>{attachment.name}</span><small>{sizeLabel(attachment.size)}</small></div>}{onRemove && <IconButton label="Убрать изображение" onClick={onRemove}><X size={12} /></IconButton>}</div>{expanded && <Modal title={attachment?.name || 'Изображение'} onClose={() => setExpanded(false)} wide><div className="image-lightbox"><img src={url} alt={attachment?.name || 'Прикреплённое изображение'} /></div></Modal>}</>;
}
function CodeBlock({ content, language }: { content: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="code-block"><div className="code-toolbar"><span>{language || 'код'}</span><IconButton label="Скопировать код" onClick={() => { void navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton></div><pre><code>{content}</code></pre></div>;
}
function MarkdownCode({ children }: { children: ReactNode }) {
  const code = Children.toArray(children).find((child) => isValidElement<{ children?: ReactNode; className?: string }>(child));
  if (!isValidElement<{ children?: ReactNode; className?: string }>(code)) return <pre>{children}</pre>;
  return <CodeBlock content={String(code.props.children ?? '')} language={code.props.className?.match(/language-([^\s]+)/)?.[1] || ''} />;
}
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}
    urlTransform={(url) => /^https?:\/\//i.test(url) ? url : ''}
    components={{
      pre: ({ children }) => <MarkdownCode>{children}</MarkdownCode>,
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span>{alt || 'Изображение'}</span>,
      table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown></div>;
}
