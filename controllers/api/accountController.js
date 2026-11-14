/**
 * Account settings for the signed-in staff member. Every action here applies
 * to req.user only — there is no user id in the URL or body, so one user can
 * never change another user's password through these endpoints.
 */
import { asyncHandler, ok } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { validationError } from "../../utils/errors.js";
import { changeOwnPassword } from "../../services/authService.js";
import { userJSON } from "../../services/serializers.js";
import { User } from "../../models/index.js";

export const changePassword = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    // The current password is only compared, never policy-checked (it may predate the policy).
    currentPassword: v.string({ required: true, max: 200 }),
    newPassword: v.password({ required: true }),
    confirmPassword: v.string({ required: true, max: 200 }),
  });
  if (req.body.newPassword !== req.body.confirmPassword) {
    throw validationError({ confirmPassword: "Passwords do not match." });
  }

  // Compare the current password exactly as typed (validate() trims plain strings).
  const { sessionVersion } = await changeOwnPassword(req.user.id, {
    currentPassword: String(req.body.currentPassword),
    newPassword: input.newPassword,
  });
  // Keep THIS session signed in; every other session of the user is now invalid.
  req.session.authVersion = sessionVersion;
  ok(res, {
    user: userJSON(await User.findByPk(req.user.id)),
    otherSessionsSignedOut: true,
  });
});
