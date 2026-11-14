
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
import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * User (abstract in the class diagram). Receptionist and Administrator are the
 * two concrete specialisations, stored in one table and distinguished by role
 * (single-table inheritance). passwordHash is excluded from default queries.
 */
export const ROLES = Object.freeze({ RECEPTIONIST: "RECEPTIONIST", ADMINISTRATOR: "ADMINISTRATOR" });

export const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    fullName: { type: DataTypes.STRING(120), allowNull: false },
    username: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(100), allowNull: false },
    role: { type: DataTypes.ENUM(...Object.values(ROLES)), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    // Set when an administrator creates the account or resets its password:
    // the user must choose their own password before using the system.
    mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Incremented on every password change/reset. Each login session stores the
    // version it was created with; older sessions are rejected (signed out).
    sessionVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    passwordChangedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "users",
    defaultScope: { attributes: { exclude: ["passwordHash"] } },
    scopes: { withPassword: { attributes: { include: ["passwordHash"] } } },
  }
);

User.prototype.isReceptionist = function isReceptionist() {
  return this.role === ROLES.RECEPTIONIST;
};
User.prototype.isAdministrator = function isAdministrator() {
  return this.role === ROLES.ADMINISTRATOR;
};
User.prototype.toSafeJSON = function toSafeJSON() {
  const { passwordHash, sessionVersion, ...rest } = this.get({ plain: true });
  return rest;
};

export { sequelize };
