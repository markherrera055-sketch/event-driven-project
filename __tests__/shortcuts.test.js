/** Ctrl/Cmd + A "New reservation" shortcut — the browser module's logic, driven with a fake document. */
import { matchesShortcut, isEditableTarget, registerShortcut, shortcutLabel, shortcutAria, isMacPlatform } from "../public/js/core/shortcuts.js";

const key = (over = {}) => ({ key: "a", code: "KeyA", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...over });

/** Minimal document: keydown listeners honouring AbortSignal, a focus target and an optional open modal. */
function fakeDocument() {
  const listeners = new Set();
  return {
    listeners,
    activeElement: { tagName: "BODY" },
    modalOpen: false,
    addEventListener(type, fn, { signal } = {}) {
      if (type !== "keydown") return;
      listeners.add(fn);
      signal?.addEventListener("abort", () => listeners.delete(fn));
    },
    querySelector() {
      return this.modalOpen ? {} : null;
    },
    press(over = {}, target = { tagName: "BODY" }) {
      const e = { ...key(over), target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      listeners.forEach((fn) => fn(e));
      return e;
    },
  };
}

describe("shortcut matching", () => {
  test("Ctrl + A on Windows/Linux, Cmd + A on macOS", () => {
    expect(matchesShortcut(key({ ctrlKey: true }), { key: "a", mac: false })).toBe(true);
    expect(matchesShortcut(key({ metaKey: true }), { key: "a", mac: true })).toBe(true);
    expect(matchesShortcut(key({ metaKey: true }), { key: "a", mac: false })).toBe(false);
    expect(matchesShortcut(key({ ctrlKey: true }), { key: "a", mac: true })).toBe(false);
  });

  test("Caps Lock and non-Latin layouts still match; other keys and modifiers do not", () => {
    expect(matchesShortcut(key({ key: "A", ctrlKey: true }), { key: "a", mac: false })).toBe(true);
    expect(matchesShortcut(key({ key: "ф", ctrlKey: true }), { key: "a", mac: false })).toBe(true);
    expect(matchesShortcut(key({ key: "s", code: "KeyS", ctrlKey: true }), { key: "a", mac: false })).toBe(false);
    expect(matchesShortcut(key({ ctrlKey: true, shiftKey: true }), { key: "a", mac: false })).toBe(false);
    expect(matchesShortcut(key({ ctrlKey: true, altKey: true }), { key: "a", mac: false })).toBe(false);
    expect(matchesShortcut(key(), { key: "a", mac: false })).toBe(false);
  });

  test("holding the keys down (auto-repeat) never re-triggers", () => {
    expect(matchesShortcut(key({ ctrlKey: true, repeat: true }), { key: "a", mac: false })).toBe(false);
  });

  test("editable targets are recognised", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test("hint and aria labels per platform", () => {
    expect(shortcutLabel("a", false)).toBe("Ctrl + A");
    expect(shortcutLabel("a", true)).toBe("⌘ A");
    expect(shortcutAria("a", false)).toBe("Control+A");
    expect(shortcutAria("a", true)).toBe("Meta+A");
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: "Windows" } })).toBe(false);
  });
});

describe("registerShortcut", () => {
  test("opens once, prevents Select All only when valid, and cleans up", () => {
    const doc = fakeDocument();
    let opened = 0;
    const dispose = registerShortcut("t-1", { key: "a", handler: () => (opened += 1), doc, mac: false });

    const e = doc.press({ ctrlKey: true });
    expect(opened).toBe(1);
    expect(e.defaultPrevented).toBe(true);

    // Typing in a field: native Select All is kept, the form does not open.
    const typing = doc.press({ ctrlKey: true }, { tagName: "INPUT" });
    expect(typing.defaultPrevented).toBe(false);
    doc.activeElement = { tagName: "DIV", isContentEditable: true };
    expect(doc.press({ ctrlKey: true }).defaultPrevented).toBe(false);
    doc.activeElement = { tagName: "BODY" };

    // Another modal open: ignored.
    doc.modalOpen = true;
    expect(doc.press({ ctrlKey: true }).defaultPrevented).toBe(false);
    doc.modalOpen = false;

    // Auto-repeat while holding the keys: ignored.
    doc.press({ ctrlKey: true, repeat: true });
    expect(opened).toBe(1);

    // Registering the same id again does not add a second listener.
    expect(registerShortcut("t-1", { key: "a", handler: () => (opened += 100), doc, mac: false })).toBe(dispose);
    expect(doc.listeners.size).toBe(1);
    doc.press({ ctrlKey: true });
    expect(opened).toBe(2);

    dispose();
    expect(doc.listeners.size).toBe(0);
    doc.press({ ctrlKey: true });
    expect(opened).toBe(2);
  });

  test("macOS uses Cmd + A and leaves Ctrl + A alone", () => {
    const doc = fakeDocument();
    let opened = 0;
    const dispose = registerShortcut("t-mac", { key: "a", handler: () => (opened += 1), doc, mac: true });
    expect(doc.press({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(doc.press({ metaKey: true }).defaultPrevented).toBe(true);
    expect(opened).toBe(1);
    dispose();
  });
});
