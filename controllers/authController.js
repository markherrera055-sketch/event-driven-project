
      /*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
/**
 * Authentication pages. Changes from the scaffold:
 *  - login is by username (class diagram: User.username), with a generic error
 *    message (no "user not found" vs "wrong password" enumeration);
 *  - the session id is regenerated on login (prevents session fixation);
 *  - public self-registration is disabled: staff accounts are created by an
 *    Administrator (Admin Console). /register now only serves the one-time
 *    first-run setup that creates the initial Administrator;
 *  - the schema is no longer synced from inside the controller (see migrate.js).
 */
import { validate, v } from "../utils/validate.js";
import { AppError } from "../utils/errors.js";
import { login, hasAnyUser, createInitialAdministrator } from "../services/authService.js";
import { startUserSession } from "../middleware/auth.js";

const homeFor = () => "/dashboard";

export const loginPage = async (req, res, next) => {
  try {
    if (req.session.userId) return res.redirect(homeFor());
    if (!(await hasAnyUser())) return res.redirect("/setup");
    res.render("login", { title: "Sign in", layout: false });
  } catch (err) {
    next(err);
  }
};

export const loginUser = async (req, res, next) => {
  try {
    const user = await login(req.body.username, req.body.password);
    if (!user) {
      return res.status(401).render("login", { title: "Sign in", error: "Invalid username or password.", username: req.body.username });
    }
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return next(err);
      startUserSession(req, user);
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        // A temporary password (new account / admin reset) must be replaced first.
        if (user.mustChangePassword) return res.redirect("/account");
        res.redirect(returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : homeFor(user));
      });
    });
  } catch (err) {
    next(err);
  }
};

export const setupPage = async (req, res, next) => {
  try {
    if (await hasAnyUser()) return res.redirect("/login");
    res.render("setup", { title: "First-time setup" });
  } catch (err) {
    next(err);
  }
};

export const setupAdministrator = async (req, res, next) => {
  try {
    if (await hasAnyUser()) return res.redirect("/login");
    let input;
    try {
      input = validate(req.body, {
        fullName: v.string({ required: true, max: 120 }),
        username: v.string({ required: true, min: 3, max: 50, lowercase: true, pattern: /^[a-z0-9._-]+$/, patternMessage: "Use lowercase letters, digits, . _ -" }),
        password: v.password({ required: true }),
      });
      if (input.username && input.password.toLowerCase().includes(input.username)) {
        throw new AppError(422, "VALIDATION_ERROR", "", { password: "Must not contain your username." });
      }
      if (req.body.password !== req.body.confirmPassword) throw new AppError(422, "VALIDATION_ERROR", "", { confirmPassword: "Passwords do not match." });
    } catch (err) {
      if (err.status !== 422) throw err;
      return res.status(422).render("setup", { title: "First-time setup", errors: err.details, values: req.body });
    }
    const user = await createInitialAdministrator(input);
    if (!user) return res.redirect("/login");
    req.session.regenerate((err) => {
      if (err) return next(err);
      startUserSession(req, user);
      req.session.save(() => res.redirect("/admin/rooms"));
    });
  } catch (err) {
    next(err);
  }
};

// Kept for existing links: self-registration is replaced by admin-managed accounts.
export const registerPage = async (req, res, next) => {
  try {
    if (!(await hasAnyUser())) return res.redirect("/setup");
    req.flash("error_msg", "Staff accounts are created by an administrator. Please contact your administrator.");
    res.redirect("/login");
  } catch (err) {
    next(err);
  }
};
export const registerUser = registerPage;

export const forgotPasswordPage = (req, res) => res.render("forgotpassword", { title: "Forgot password" });

export const logoutUser = (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("frontdesk.sid");
    res.redirect("/login");
  });
};
