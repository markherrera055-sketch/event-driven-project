/** Room and Staff Admin module — staff accounts (Administrator.manageStaffAccounts). */
import { Op } from "sequelize";
import { User, ROLES } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { generateTemporaryPassword } from "../utils/password.js";
import { hashPassword, assertPasswordAllowed } from "./authService.js";
import { userJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { logger } from "../utils/logger.js";

export async function listStaff({ search, role, isActive } = {}) {
  const where = {};
  if (role) where.role = role;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where[Op.or] = [{ fullName: { [Op.like]: `%${search}%` } }, { username: { [Op.like]: `%${search}%` } }];
  const users = await User.findAll({ where, order: [["fullName", "ASC"]] });
  return users.map(userJSON);
}

/**
 * The administrator chooses a temporary password; the new user must replace
 * it with their own at first sign-in (mustChangePassword).
 */
export async function createStaff({ fullName, username, password, role }, actor) {
  const existing = await User.findOne({ where: { username } });
  if (existing) throw conflict("USERNAME_TAKEN", "That username is already in use.", { username: "Already in use." });
  assertPasswordAllowed(password, { username });
  const user = await User.create({ fullName, username, role, passwordHash: await hashPassword(password), mustChangePassword: true });
  logger.info("staff_created", { userId: user.id, role, by: actor.id });
  return userJSON(user);
}

export async function updateStaff(id, changes, actor) {
  return withTransaction(null, async (transaction) => {
    const user = await User.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw notFound("Staff account");

    const losingAdmin =
      user.role === ROLES.ADMINISTRATOR &&
      ((changes.role && changes.role !== ROLES.ADMINISTRATOR) || changes.isActive === false);
    if (losingAdmin) {
      if (user.id === actor.id) throw conflict("SELF_LOCKOUT", "You cannot remove your own administrator access.");
      const otherAdmins = await User.count({
        where: { role: ROLES.ADMINISTRATOR, isActive: true, id: { [Op.ne]: user.id } },
        transaction,
      });
      if (otherAdmins === 0) throw conflict("LAST_ADMIN", "At least one active administrator must remain.");
    }

    if (changes.username && changes.username !== user.username) {
      const taken = await User.findOne({ where: { username: changes.username }, transaction });
      if (taken) throw conflict("USERNAME_TAKEN", "That username is already in use.", { username: "Already in use." });
    }

    const update = {};
    for (const key of ["fullName", "username", "role", "isActive"]) if (changes[key] !== undefined) update[key] = changes[key];
    if (changes.password) {
      // Same rules as the dedicated reset endpoint.
      if (user.id === actor.id) throw conflict("USE_ACCOUNT_SETTINGS", "Change your own password from Account settings (your current password is required).");
      assertPasswordAllowed(changes.password, { username: update.username ?? user.username });
      Object.assign(update, await resetFields(user, changes.password));
    }
    // Deactivating an account also ends its open sessions immediately.
    if (changes.isActive === false && user.isActive) update.sessionVersion = update.sessionVersion ?? user.sessionVersion + 1;
    await user.update(update, { transaction });
    logger.info("staff_updated", { userId: user.id, fields: Object.keys(update).filter((k) => k !== "passwordHash"), passwordReset: !!changes.password, by: actor.id });
    return userJSON(user);
  });
}

const resetFields = async (user, password) => ({
  passwordHash: await hashPassword(password),
  passwordChangedAt: new Date(),
  mustChangePassword: true,
  sessionVersion: user.sessionVersion + 1,
});

/**
 * Administrator-initiated password reset. Existing passwords are never read
 * or shown. The administrator either supplies a temporary password or lets
 * the server generate a strong one, which is returned ONCE in this response
 * so it can be handed to the staff member. In both cases:
 *  - the account is flagged mustChangePassword (the user must pick their own
 *    password at next sign-in, before any other action);
 *  - all of the user's open sessions are signed out (sessionVersion bump).
 * Administrators cannot reset their own password here: changing your own
 * password requires proving the current one (Account settings).
 */
export async function resetStaffPassword(id, { temporaryPassword } = {}, actor) {
  const user = await User.findByPk(id);
  if (!user) throw notFound("Staff account");
  if (user.id === actor.id) {
    throw conflict("USE_ACCOUNT_SETTINGS", "Change your own password from Account settings (your current password is required).");
  }
  const generated = !temporaryPassword;
  const password = temporaryPassword || generateTemporaryPassword();
  assertPasswordAllowed(password, user, "temporaryPassword");
  await user.update(await resetFields(user, password));
  logger.info("staff_password_reset", { userId: user.id, generated, by: actor.id });
  return { user: userJSON(user), temporaryPassword: generated ? password : undefined, generated };
}
