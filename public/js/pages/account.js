/**
 * Account settings — the signed-in user's profile and self-service password
 * change. The API only ever changes the caller's own password (PUT /me/password).
 */
import "../core/shell.js";
import { api, ApiError } from "../core/api.js";
import { $, html, setHTML, dateTime, badge, errorHTML, passwordField, clearFieldErrors, showFieldErrors, withBusy, toast, errorMessage } from "../core/ui.js";
import { PASSWORD_HINT, passwordFeedbackHTML, bindPasswordFeedback, passwordProblem } from "../core/password.js";

const root = $("#page-root");
const forced = document.body.dataset.passwordChange === "required";
let user;

function profileCard() {
  return html`<div class="card"><div class="card-head"><h2>Profile</h2>${badge(user.role)}</div>
    <div class="card-body"><dl class="dl">
      <dt>Name</dt><dd>${user.fullName}</dd>
      <dt>Username</dt><dd class="mono">${user.username}</dd>
      <dt>Last sign-in</dt><dd>${user.lastLoginAt ? dateTime(user.lastLoginAt) : "—"}</dd>
      <dt>Password changed</dt><dd>${user.passwordChangedAt ? dateTime(user.passwordChangedAt) : "Not since the account was created"}</dd>
    </dl>
    <p class="hint">Your name, username and role are managed by an administrator.</p></div></div>`;
}

function render() {
  setHTML(
    root,
    html`<div class="grid grid-main">
      <div class="card">
        <div class="card-head"><h2>Change password</h2></div>
        <form class="card-body" id="password-form" novalidate>
          ${forced ? html`<div class="alert alert-warning"><strong>Set a new password to continue.</strong> Your account is using a temporary password given by an administrator.</div>` : ""}
          <div id="form-alert"></div>
          <input type="text" name="username" value="${user.username}" autocomplete="username" class="hidden" readonly tabindex="-1" aria-hidden="true">
          ${passwordField({ name: "currentPassword", label: forced ? "Temporary password" : "Current password", autocomplete: "current-password" })}
          ${passwordField({ name: "newPassword", label: "New password", hint: PASSWORD_HINT, extra: passwordFeedbackHTML() })}
          ${passwordField({ name: "confirmPassword", label: "Confirm new password" })}
          <div class="row">
            <button type="submit" class="btn btn-primary">Update password</button>
          </div>
          <p class="hint">You stay signed in on this device. For security, all your other signed-in sessions are signed out.</p>
        </form>
      </div>
      <div class="stack">${profileCard()}</div>
    </div>`
  );
  const form = $("#password-form");
  bindPasswordFeedback(form, { name: "newPassword", confirmName: "confirmPassword", username: user.username });
  form.addEventListener("submit", submit);
}

/** Client-side checks first (instant feedback); the server re-checks everything. */
function localErrors(v) {
  const errors = {};
  if (!v.currentPassword) errors.currentPassword = "This field is required.";
  const problem = v.newPassword ? passwordProblem(v.newPassword, { username: user.username }) : "This field is required.";
  if (problem) errors.newPassword = problem;
  if (!v.confirmPassword) errors.confirmPassword = "This field is required.";
  else if (v.newPassword !== v.confirmPassword) errors.confirmPassword = "Passwords do not match.";
  if (!errors.newPassword && v.newPassword === v.currentPassword) errors.newPassword = "Choose a password different from your current one.";
  return errors;
}

async function submit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const alertBox = $("#form-alert", form);
  clearFieldErrors(form);
  alertBox.innerHTML = "";
  // Read raw values: passwords are never trimmed.
  const v = Object.fromEntries(["currentPassword", "newPassword", "confirmPassword"].map((n) => [n, form.elements[n].value]));
  const errors = localErrors(v);
  if (Object.keys(errors).length) {
    showFieldErrors(form, errors);
    form.querySelector(".has-error input")?.focus();
    return;
  }
  try {
    const result = await withBusy(form.querySelector('button[type="submit"]'), () => api.put("/me/password", v));
    user = result.user;
    form.reset();
    form.querySelectorAll("[data-password]").forEach((input) => (input.type = "password"));
    form.querySelectorAll("[data-toggle-password]").forEach((b) => {
      b.textContent = "Show";
      b.setAttribute("aria-pressed", "false");
    });
    form.elements.newPassword.dispatchEvent(new Event("input"));
    toast("Password updated. Your other sessions were signed out.", "success");
    setHTML(alertBox, html`<div class="alert alert-success">Password updated ${dateTime(user.passwordChangedAt)}. Use the new password next time you sign in.</div>`);
    if (forced) setTimeout(() => (window.location.href = "/dashboard"), 1200);
    else setHTML(root.querySelector(".grid > .stack"), profileCard());
  } catch (err) {
    const inline = err instanceof ApiError && err.status === 422 && showFieldErrors(form, err.details);
    if (!inline) setHTML(alertBox, html`<div class="alert alert-danger">${errorMessage(err)}</div>`);
  }
}

async function load() {
  try {
    user = (await api.get("/me")).user;
    render();
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

load();
