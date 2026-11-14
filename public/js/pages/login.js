/**
 * Sign-in page enhancements. The server (POST /login) remains the authority on
 * credentials; this only adds:
 *  - required-field checks with inline, accessible error messages;
 *  - a single-submit loading state (prevents duplicate submissions);
 *  - show / hide password, via the shared [data-toggle-password] handler in ui.js.
 */
import "../core/ui.js";

const form = document.querySelector("[data-login-form]");

if (form) {
  const button = form.querySelector("[data-submit]");
  const idleLabel = button.innerHTML;
  const { username, password } = form.elements;
  let submitting = false;

  const setFieldError = (input, message) => {
    const field = input.closest(".field");
    const noteId = `${input.id}-error`;
    let note = document.getElementById(noteId);
    if (!message) {
      field.classList.remove("has-error");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      note?.remove();
      return;
    }
    if (!note) {
      note = document.createElement("div");
      note.className = "field-error";
      note.id = noteId;
      field.appendChild(note);
    }
    note.textContent = message;
    field.classList.add("has-error");
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", noteId);
  };

  const setBusy = (busy) => {
    submitting = busy;
    button.disabled = busy;
    button.toggleAttribute("aria-busy", busy);
    if (busy) {
      button.textContent = "";
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = "Signing in…";
      button.append(spinner, text);
    } else {
      button.innerHTML = idleLabel;
    }
  };

  form.addEventListener("submit", (event) => {
    if (submitting) {
      event.preventDefault();
      return;
    }
    const problems = [
      [username, username.value.trim() ? null : "Enter your username."],
      [password, password.value ? null : "Enter your password."],
    ];
    let firstInvalid = null;
    for (const [input, message] of problems) {
      setFieldError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    }
    if (firstInvalid) {
      event.preventDefault();
      firstInvalid.focus();
      return;
    }
    setBusy(true);
  });

  // Clear a field's error as soon as the user corrects it.
  form.addEventListener("input", (event) => {
    const input = event.target;
    if (input === username || input === password) {
      if (input.closest(".has-error") && (input === password ? input.value : input.value.trim())) setFieldError(input, null);
    }
  });

  // Restore the button when the page is shown again from the back/forward cache.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) setBusy(false);
  });
}
