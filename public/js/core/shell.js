/** Behaviour shared by every authenticated page: mobile menu, today's date, avatar initials, keyboard shortcuts. */
import { initials, session } from "./ui.js";
import { registerShortcut, shortcutLabel, shortcutAria } from "./shortcuts.js";
import { startNewReservation } from "./reservationForm.js";

const toggle = document.getElementById("menu-toggle");
const sidebar = document.getElementById("sidebar");
toggle?.addEventListener("click", () => sidebar.classList.toggle("open"));
document.addEventListener("click", (e) => {
  if (sidebar?.classList.contains("open") && !sidebar.contains(e.target) && e.target !== toggle) sidebar.classList.remove("open");
});

const today = document.getElementById("today");
if (today) today.textContent = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

const avatar = document.getElementById("avatar");
if (avatar) avatar.textContent = initials(avatar.textContent);

// Ctrl + A (Windows/Linux) / Cmd + A (macOS): open the New reservation form from
// any page. Only receptionists can create reservations, and not while a
// temporary password still has to be replaced.
if (session.isReceptionist && document.body.dataset.passwordChange !== "required") {
  registerShortcut("new-reservation", { key: "a", handler: () => startNewReservation() });
  document.querySelectorAll("[data-shortcut-hint]").forEach((hint) => {
    hint.textContent = shortcutLabel(hint.dataset.shortcutHint);
    hint.closest("button, a")?.setAttribute("aria-keyshortcuts", shortcutAria(hint.dataset.shortcutHint));
  });
} else {
  document.querySelectorAll("[data-shortcut-hint]").forEach((hint) => hint.remove());
}
