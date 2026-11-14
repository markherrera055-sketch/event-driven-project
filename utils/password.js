/**
 * Staff password policy — the single server-side source of truth.
 * (public/js/core/password.js mirrors these rules for live feedback only;
 * the server always re-checks.)
 *
 *  - 10 to 72 characters (bcrypt only uses the first 72 bytes, so longer
 *    input is refused rather than silently truncated);
 *  - at least one lowercase letter, one uppercase letter, one number and one
 *    symbol;
 *  - must not contain the username, and must not be a common password with a
 *    few digits/symbols added (e.g. "Password123!").
 */
import crypto from "crypto";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX_BYTES = 72;

const COMMON = new Set([
  "password", "passw0rd", "qwerty", "qwertyuiop", "asdfgh", "letmein", "welcome", "admin", "administrator",
  "iloveyou", "monkey", "dragon", "sunshine", "princess", "football", "baseball", "abc", "abcdef", "changeme",
  "secret", "hotel", "frontdesk", "reception", "receptionist", "manager", "guest", "login", "master", "default",
]);

/** Returns a list of human-readable problems (empty when the password is acceptable). */
export function passwordProblems(password, { username } = {}) {
  const pw = String(password ?? "");
  const problems = [];
  if (pw.length < PASSWORD_MIN) problems.push(`at least ${PASSWORD_MIN} characters`);
  if (Buffer.byteLength(pw, "utf8") > PASSWORD_MAX_BYTES) problems.push(`at most ${PASSWORD_MAX_BYTES} characters`);
  if (!/[a-z]/.test(pw)) problems.push("a lowercase letter");
  if (!/[A-Z]/.test(pw)) problems.push("an uppercase letter");
  if (!/[0-9]/.test(pw)) problems.push("a number");
  if (!/[^A-Za-z0-9]/.test(pw)) problems.push("a symbol");
  return problems.length ? [`Must contain ${problems.join(", ")}.`] : contextProblems(pw, { username });
}

function contextProblems(pw, { username }) {
  const lower = pw.toLowerCase();
  if (username && String(username).length >= 3 && lower.includes(String(username).toLowerCase())) {
    return ["Must not contain your username."];
  }
  const core = lower.replace(/[^a-z]/g, "");
  if (COMMON.has(core) || /^(.)\1+$/.test(core)) return ["Too common or easy to guess. Choose something less predictable."];
  return [];
}

/** First problem as a single message, or null. */
export const passwordError = (password, context) => passwordProblems(password, context)[0] || null;

/**
 * Cryptographically random temporary password that satisfies the policy
 * (look-alike characters such as O/0 and l/1 are left out so it can be read
 * aloud or copied by hand).
 */
export function generateTemporaryPassword(length = 14) {
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "#$%&*+-=?@"];
  const all = sets.join("");
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const chars = [...sets.map(pick), ...Array.from({ length: length - sets.length }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
