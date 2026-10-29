import { Check, ChevronDown, LoaderCircle } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ComposerSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ComposerSelectProps {
  value: string;
  options: readonly ComposerSelectOption[];
  ariaLabel: string;
  describedBy?: string;
  testId?: string;
  icon?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  onChange: (value: string) => void;
}

interface MenuPosition { left: number; top: number; width: number; maxHeight: number; side: 'above' | 'below' }

export function ComposerSelect({ value, options, ariaLabel, describedBy, testId, icon, disabled, busy, className, onChange }: ComposerSelectProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: '', timestamp: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const enabledIndices = useMemo(() => options.flatMap((option, index) => option.disabled ? [] : [index]), [options]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const unavailable = disabled || enabledIndices.length === 0;

  function closeMenu() {
    setOpen(false);
    setPosition(null);
    searchRef.current = { text: '', timestamp: 0 };
  }

  function openMenu(preferLast = false) {
    if (unavailable) return;
    setActiveIndex(enabledIndices.includes(selectedIndex) ? selectedIndex : enabledIndices[preferLast ? enabledIndices.length - 1 : 0]);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled || unavailable) return;
    closeMenu();
    triggerRef.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  }

  function moveActive(direction: -1 | 1) {
    const current = enabledIndices.indexOf(activeIndex);
    const next = current < 0 ? (direction === 1 ? 0 : enabledIndices.length - 1) : (current + direction + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[next]);
  }

  function searchOptions(key: string) {
    const now = Date.now();
    const previous = now - searchRef.current.timestamp < 700 ? searchRef.current.text : '';
    const query = `${previous}${key}`.toLocaleLowerCase();
    searchRef.current = { text: query, timestamp: now };
    // Repeated letters cycle through matches, as native selects do.
    const repeated = [...query].every((character) => character === query[0]);
    const search = repeated ? query[0] : query;
    const current = enabledIndices.indexOf(open ? activeIndex : selectedIndex);
    const offset = previous && !repeated ? 0 : 1;
    for (let step = 0; step < enabledIndices.length; step++) {
      const candidate = enabledIndices[(Math.max(current, -1) + offset + step + enabledIndices.length) % enabledIndices.length];
      if (options[candidate].label.trim().toLocaleLowerCase().startsWith(search)) {
        setActiveIndex(candidate);
        setOpen(true);
        return;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu(event.key === 'ArrowUp');
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(enabledIndices[event.key === 'Home' ? 0 : enabledIndices.length - 1]);
      setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    } else if (event.key === 'Tab') {
      closeMenu();
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      searchOptions(event.key);
    }
  }

  useEffect(() => {
    if (unavailable) closeMenu();
  }, [unavailable]);

  useEffect(() => {
    if (open && !enabledIndices.includes(activeIndex)) {
      setActiveIndex(enabledIndices.includes(selectedIndex) ? selectedIndex : (enabledIndices[0] ?? -1));
    }
  }, [open, activeIndex, enabledIndices, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !triggerRef.current?.contains(target) && !listboxRef.current?.contains(target)) closeMenu();
    };
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('focusin', handleOutside);
    return () => {
      document.removeEventListener('pointerdown', handleOutside, true);
      document.removeEventListener('focusin', handleOutside);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    let animationFrame = 0;
    const update = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const menu = listboxRef.current;
      if (!anchor || !menu) return;
      const edge = 10;
      const gap = 7;
      const width = Math.min(Math.max(anchor.width, 300), Math.max(0, window.innerWidth - edge * 2));
      menu.style.width = `${width}px`;
      const naturalHeight = menu.scrollHeight + 2;
      const above = Math.max(0, anchor.top - gap - edge);
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - edge);
      const side = naturalHeight <= above || above >= below ? 'above' : 'below';
      const maxHeight = Math.min(360, side === 'above' ? above : below);
      const height = Math.min(naturalHeight, maxHeight);
      const next: MenuPosition = {
        left: Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge)),
        top: side === 'above' ? Math.max(edge, anchor.top - gap - height) : anchor.bottom + gap,
        width,
        maxHeight,
        side,
      };
      setPosition((previous) => previous && Object.keys(next).every((key) => previous[key as keyof MenuPosition] === next[key as keyof MenuPosition]) ? previous : next);
    };
    const schedule = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(schedule);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (listboxRef.current) observer.observe(listboxRef.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, options]);

  useLayoutEffect(() => {
    if (open && position && activeIndex >= 0) {
      const option = listboxRef.current?.children[activeIndex];
      if (option instanceof HTMLElement) option.scrollIntoView({ block: 'nearest' });
    }
  }, [open, position, activeIndex]);

  const menuStyle: CSSProperties = position
    ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }
    : { left: 0, top: 0, visibility: 'hidden' };

  return <div className={`composer-select-wrap${className ? ` ${className}` : ''}${unavailable ? ' is-disabled' : ''}`}>
    <button ref={triggerRef} type="button" className="composer-select-trigger" role="combobox"
      aria-label={ariaLabel} aria-describedby={describedBy} aria-expanded={open} aria-haspopup="listbox"
      aria-controls={open ? listboxId : undefined} aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
      aria-busy={busy || undefined} disabled={unavailable} data-testid={testId} data-value={value}
      onClick={() => open ? closeMenu() : openMenu()} onKeyDown={handleKeyDown}>
      {busy ? <LoaderCircle size={13} className="composer-select-icon spin" aria-hidden="true" /> : icon && <span className="composer-select-icon" aria-hidden="true">{icon}</span>}
      <span className="composer-select-label">{selected?.label ?? 'Выбрать'}</span>
      <ChevronDown size={11} className="composer-select-chevron" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={listboxRef} id={listboxId} className="composer-select-menu" role="listbox"
      aria-label={ariaLabel} data-testid={testId ? `${testId}-listbox` : undefined} data-side={position?.side} style={menuStyle}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-label={option.label}
        aria-describedby={option.description ? `${id}-description-${index}` : undefined}
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-value={option.value}
        className={`composer-select-option${activeIndex === index ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}
        onMouseDown={(event) => event.preventDefault()} onMouseMove={() => !option.disabled && setActiveIndex(index)} onClick={() => choose(index)}>
        <span className="composer-select-option-copy"><span className="composer-select-option-label">{option.label}</span>
          {option.description && <span id={`${id}-description-${index}`} className="composer-select-option-description">{option.description}</span>}</span>
        <span className="composer-select-check" aria-hidden="true">{option.value === value && <Check size={14} strokeWidth={2} />}</span>
      </div>)}
    </div>, document.body)}
  </div>;
}
