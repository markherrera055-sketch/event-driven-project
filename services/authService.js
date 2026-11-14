import bcrypt from "bcrypt";
import { User, ROLES } from "../models/index.js";
import { logger } from "../utils/logger.js";
import { notFound, validationError } from "../utils/errors.js";
import { passwordError } from "../utils/password.js";

const BCRYPT_ROUNDS = 12;
// Compared against when the username does not exist, so a failed login takes
// the same time whether or not the account exists (no user enumeration).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

/** User.login(): returns the user on success, null otherwise (no reason given to the caller). */
export async function login(username, password) {
  const user = await User.scope("withPassword").findOne({ where: { username: String(username || "").trim().toLowerCase() } });
  const match = await bcrypt.compare(String(password || ""), user ? user.passwordHash : DUMMY_HASH);
  if (!user || !match || !user.isActive) {
    logger.warn("login_failed", { username: String(username || "").slice(0, 50) });
    return null;
  }
  await user.update({ lastLoginAt: new Date() });
  logger.info("login_success", { userId: user.id, role: user.role });
  return user;
}

export const hasAnyUser = async () => (await User.count()) > 0;

/** Policy check that also needs the account (username), e.g. for staff create / reset / change. */
export function assertPasswordAllowed(password, user, field = "password") {
  const error = passwordError(password, { username: user?.username });
  if (error) throw validationError({ [field]: error });
}

/**
 * Self-service password change (User.changePassword). Only ever acts on the
 * signed-in user's own account — the caller passes req.user.id, never an id
 * taken from the request. The current password must be proven first.
 *
 * On success every other login session of this user is invalidated by
 * bumping sessionVersion; the caller re-stamps the current session with the
 * returned version so it stays signed in.
 */
export async function changeOwnPassword(userId, { currentPassword, newPassword }) {
  const user = await User.scope("withPassword").findByPk(userId);
  if (!user || !user.isActive) throw notFound("User");

  if (!(await bcrypt.compare(String(currentPassword || ""), user.passwordHash))) {
    logger.warn("password_change_failed", { userId: user.id, reason: "wrong_current_password" });
    throw validationError({ currentPassword: "Current password is incorrect." });
  }
  assertPasswordAllowed(newPassword, user, "newPassword");
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw validationError({ newPassword: "Choose a password different from your current one." });
  }

  await user.update({
    passwordHash: await hashPassword(newPassword),
    passwordChangedAt: new Date(),
    mustChangePassword: false,
    sessionVersion: user.sessionVersion + 1,
  });
  logger.info("password_changed", { userId: user.id });
  return { sessionVersion: user.sessionVersion, passwordChangedAt: user.passwordChangedAt };
}

/** First-run setup: creates the initial Administrator only while no users exist. */
export async function createInitialAdministrator({ fullName, username, password }) {
  if (await hasAnyUser()) return null;
  return User.create({
    fullName,
    username,
    passwordHash: await hashPassword(password),
    role: ROLES.ADMINISTRATOR,
  });
}
