import { useEffect, useRef } from 'react';

export type ShortcutHandler = (event: KeyboardEvent) => void;

export interface ShortcutDefinition {
  /** Key to match, compared case-insensitively against event.key. */
  key: string;
  /** Require Cmd (macOS) or Ctrl (other platforms) to be held. */
  meta?: boolean;
  /** Require Shift to be held. */
  shift?: boolean;
  /** Require Alt to be held. */
  alt?: boolean;
  /** Human readable description used for tooltips and the help modal. */
  description?: string;
  /** Handler invoked when the shortcut matches. */
  handler: ShortcutHandler;
}

export type ShortcutMap = Record<string, ShortcutDefinition>;

/**
 * Default shortcut mappings for power users.
 * Keys are stable identifiers so callers can reference them (e.g. for tooltips).
 */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  search: {
    key: 'k',
    meta: true,
    description: 'Open search',
    handler: () => {},
  },
  newDid: {
    key: 'n',
    meta: true,
    description: 'Create new DID',
    handler: () => {},
  },
  help: {
    key: '?',
    shift: true,
    description: 'Show keyboard shortcuts',
    handler: () => {},
  },
};

const isMac = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform);
};

/**
 * Returns true when the event target is an editable field where shortcuts
 * should be ignored so typing is not intercepted.
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};

const matches = (event: KeyboardEvent, shortcut: ShortcutDefinition): boolean => {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;

  const wantsMeta = Boolean(shortcut.meta);
  const hasMeta = isMac() ? event.metaKey : event.ctrlKey;
  if (wantsMeta !== hasMeta) return false;

  // On macOS, Ctrl should not accidentally trigger Cmd shortcuts and vice versa.
  if (isMac() && event.ctrlKey && wantsMeta) return false;
  if (!isMac() && event.metaKey && wantsMeta) return false;

  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  if (Boolean(shortcut.alt) !== event.altKey) return false;

  return true;
};

/**
 * Registers global keyboard shortcuts for power users.
 *
 * @param shortcuts Map of shortcut definitions keyed by a stable identifier.
 * @param options.enabled When false, no listeners are attached.
 */
export function useKeyboardShortcuts(
  shortcuts: ShortcutMap = DEFAULT_SHORTCUTS,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      for (const shortcut of Object.values(shortcutsRef.current)) {
        if (matches(event, shortcut)) {
          event.preventDefault();
          shortcut.handler(event);
          return;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

export default useKeyboardShortcuts;
