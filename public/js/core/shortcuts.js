/**
 * Global keyboard shortcuts (Ctrl + key on Windows/Linux, Cmd + key on macOS).
 *
 * A shortcut fires only when:
 *  - exactly the platform modifier is held (no Shift/Alt) and it is not an
 *    auto-repeat from holding the keys down (one press = one trigger);
 *  - the user is NOT typing in an input, textarea, select or contenteditable
 *    element (there the browser's own behaviour, e.g. Select All, is kept);
 *  - no modal dialog is open.
 * Only then is the browser default prevented. Each shortcut id is registered
 * at most once, and registration returns a dispose() that removes the listener.
 */

export const isMacPlatform = (nav = globalThis.navigator) =>
  /Mac|iPhone|iPad|iPod/i.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "");

/** Visible hint, e.g. "Ctrl + A" or "⌘ A". */
export const shortcutLabel = (key, mac = isMacPlatform()) => (mac ? `⌘ ${key.toUpperCase()}` : `Ctrl + ${key.toUpperCase()}`);
/** Value for aria-keyshortcuts. */
export const shortcutAria = (key, mac = isMacPlatform()) => `${mac ? "Meta" : "Control"}+${key.toUpperCase()}`;

/** True when keyboard focus is in a place where the user types text. */
export function isEditableTarget(el) {
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Letter pressed, independent of Caps Lock; falls back to the physical key for non-Latin layouts. */
const letterOf = (e) => {
  if (typeof e.key === "string" && /^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code || "");
  return m ? m[1].toLowerCase() : "";
};

/** Does this keydown match Ctrl+key (Windows/Linux) or Cmd+key (macOS)? */
export function matchesShortcut(e, { key, mac }) {
  if (!e || e.repeat || e.isComposing || e.altKey || e.shiftKey) return false;
  if (letterOf(e) !== key.toLowerCase()) return false;
  return mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

const MODAL_SELECTOR = ".modal-backdrop, [role='dialog'][aria-modal='true'], dialog[open]";
const registry = new Map();

/**
 * registerShortcut("new-reservation", { key: "a", handler, when })
 * Returns dispose(). Registering the same id again returns the existing dispose
 * instead of adding a second listener.
 */
export function registerShortcut(id, { key, handler, when = () => true, doc = globalThis.document, mac = isMacPlatform() }) {
  if (registry.has(id)) return registry.get(id);
  const controller = new AbortController();

  const onKeyDown = (e) => {
    if (e.defaultPrevented || !matchesShortcut(e, { key, mac })) return;
    if (isEditableTarget(e.target) || isEditableTarget(doc.activeElement)) return; // keep native Select All while typing
    if (doc.querySelector(MODAL_SELECTOR)) return; // another dialog is active
    if (!when()) return;
    e.preventDefault();
    handler(e);
  };

  doc.addEventListener("keydown", onKeyDown, { signal: controller.signal });
  const dispose = () => {
    controller.abort();
    registry.delete(id);
  };
  registry.set(id, dispose);
  return dispose;
}
