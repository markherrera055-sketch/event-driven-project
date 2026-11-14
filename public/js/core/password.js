/**
 * Live password feedback (requirement checklist, strength meter, "passwords
 * match"). Mirrors utils/password.js for guidance only — the server always
 * re-validates and is the authority.
 */
import { html, $ } from "./ui.js";

export const PASSWORD_HINT = "At least 10 characters with uppercase and lowercase letters, a number and a symbol.";

const RULES = [
  { id: "length", text: "At least 10 characters", test: (p) => p.length >= 10 },
  { id: "case", text: "Uppercase and lowercase letters", test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { id: "number", text: "A number", test: (p) => /[0-9]/.test(p) },
  { id: "symbol", text: "A symbol (e.g. # $ % & *)", test: (p) => /[^A-Za-z0-9]/.test(p) },
];

const tooLong = (p) => new TextEncoder().encode(p).length > 72;
const LEVELS = ["Too weak", "Weak", "Fair", "Good", "Strong"];

/** 0–4: rules met, with a bonus for length and a cap when a rule is missing. */
export function strengthScore(p, { username } = {}) {
  if (!p) return 0;
  const met = RULES.filter((r) => r.test(p)).length;
  if (username && username.length >= 3 && p.toLowerCase().includes(username.toLowerCase())) return 1;
  let score = met === RULES.length ? 3 : Math.min(met, 2);
  if (met === RULES.length && p.length >= 14) score = 4;
  return score;
}

/** First problem the server would also report (null when acceptable). */
export function passwordProblem(p, { username } = {}) {
  if (tooLong(p)) return "Must be at most 72 characters.";
  const missing = RULES.filter((r) => !r.test(p));
  if (missing.length) return `Missing: ${missing.map((r) => r.text.toLowerCase()).join(", ")}.`;
  if (username && username.length >= 3 && p.toLowerCase().includes(username.toLowerCase())) return "Must not contain your username.";
  return null;
}

/** Checklist + meter markup, placed under the new-password field. */
export const passwordFeedbackHTML = () => html`
  <div class="pw-feedback" data-pw-feedback>
    <div class="pw-meter" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
    <div class="pw-meter-label small muted" aria-live="polite">Strength: —</div>
    <ul class="pw-rules">${RULES.map((r) => html`<li data-rule="${r.id}"><span class="check-indicator" aria-hidden="true"></span><span>${r.text}</span></li>`)}</ul>
  </div>`;

/**
 * Wires the feedback block to the inputs in `form`.
 * confirmName (optional) shows a live "passwords match / do not match" note.
 */
export function bindPasswordFeedback(form, { name = "newPassword", confirmName, username } = {}) {
  const input = form.querySelector(`[name="${name}"]`);
  const box = $("[data-pw-feedback]", form);
  const confirm = confirmName ? form.querySelector(`[name="${confirmName}"]`) : null;
  let matchNote = null;
  if (confirm) {
    matchNote = document.createElement("div");
    matchNote.className = "hint pw-match";
    matchNote.setAttribute("aria-live", "polite");
    confirm.closest(".field").appendChild(matchNote);
  }

  const update = () => {
    const p = input.value;
    RULES.forEach((r) => {
      const ok = r.test(p);
      const li = box.querySelector(`[data-rule="${r.id}"]`);
      li.classList.toggle("ok", ok);
      li.querySelector(".check-indicator").classList.toggle("ok", ok);
    });
    const score = strengthScore(p, { username });
    box.dataset.score = p ? String(score) : "";
    box.querySelector(".pw-meter-label").textContent = p ? `Strength: ${LEVELS[score]}${tooLong(p) ? " (too long)" : ""}` : "Strength: —";
    if (matchNote) {
      const c = confirm.value;
      matchNote.textContent = c ? (c === p ? "Passwords match." : "Passwords do not match.") : "";
      matchNote.classList.toggle("is-ok", !!c && c === p);
      matchNote.classList.toggle("is-bad", !!c && c !== p);
    }
  };
  input.addEventListener("input", update);
  confirm?.addEventListener("input", update);
  update();
  return update;
}
