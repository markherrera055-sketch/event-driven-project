/**
 * Session authentication + role-based access (Figure 3: "API Router and
 * Authentication (role-based access)"). Follows the XianFire generator's
 * requireAuth / requireRole naming.
 *
 * API requests get JSON 401/403 responses; page requests are redirected.
 *
 * Password management rules enforced here:
 *  - A session is valid only while its authVersion equals the user's
 *    sessionVersion. Changing or resetting a password bumps the version, which
 *    signs out every other session of that user (works with any session store).
 *  - An account flagged mustChangePassword (new account / admin reset) can
 *    only reach the routes marked allowPendingPasswordChange (Account settings,
 *    /me, the change-password endpoint and logout) until a new password is set.
 */
import { User, ROLES } from "../models/index.js";
import { fail } from "../utils/http.js";

const isApi = (req) => req.originalUrl.startsWith("/api/");

/** Stamp a session as belonging to `user` (call right after login / session regeneration). */
export const startUserSession = (req, user) => {
  req.session.userId = user.id;
  req.session.authVersion = user.sessionVersion ?? 0;
};

const endSession = (req, res, { message } = {}) => {
  req.session.userId = null;
  req.session.authVersion = undefined;
  if (isApi(req)) return fail(res, 401, "UNAUTHORIZED", message || "Please sign in.");
  if (message) req.flash("error_msg", message);
  req.session.returnTo = req.method === "GET" ? req.originalUrl : undefined;
  return res.redirect("/login");
};

const authenticate = ({ allowPendingPasswordChange = false } = {}) =>
  async (req, res, next) => {
    try {
      const user = req.session.userId ? await User.findByPk(req.session.userId) : null;
      if (!user || !user.isActive) return endSession(req, res);
      if ((req.session.authVersion ?? 0) !== (user.sessionVersion ?? 0)) {
        return endSession(req, res, { message: "Your password was changed, so you were signed out. Please sign in again." });
      }
      req.user = user;
      res.locals.currentUser = user.toSafeJSON();
      res.locals.isAdmin = user.role === ROLES.ADMINISTRATOR;
      res.locals.isReceptionist = user.role === ROLES.RECEPTIONIST;

      if (user.mustChangePassword && !allowPendingPasswordChange) {
        if (isApi(req)) {
          return fail(res, 403, "PASSWORD_CHANGE_REQUIRED", "You must set a new password before continuing. Open Account settings.");
        }
        return res.redirect("/account");
      }
      next();
    } catch (error) {
      next(error);
    }
  };

export const requireAuth = authenticate();

export const requireRole = (role, options = {}) => {
  const allowed = Array.isArray(role) ? role : [role];
  return [
    authenticate(options),
    (req, res, next) => {
      if (allowed.includes(req.user.role)) return next();
      if (isApi(req)) return fail(res, 403, "FORBIDDEN", "Your role is not allowed to perform this action.");
      return res.status(403).render("error", {
        title: "Access denied",
        status: 403,
        message: "Your account does not have access to this page.",
      });
    },
  ];
};

const ALL_STAFF = [ROLES.RECEPTIONIST, ROLES.ADMINISTRATOR];

export const receptionistOnly = requireRole(ROLES.RECEPTIONIST);
export const adminOnly = requireRole(ROLES.ADMINISTRATOR);
export const anyStaff = requireRole(ALL_STAFF);
/** Any signed-in staff member, including one who still has to replace a temporary password. */
export const anyStaffAccount = requireRole(ALL_STAFF, { allowPendingPasswordChange: true });
