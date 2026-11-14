import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const VERIFICATION_RESULT = Object.freeze({ VERIFIED: "VERIFIED", FAILED: "FAILED" });
export const ID_TYPES = Object.freeze(["PASSPORT", "DRIVERS_LICENSE", "NATIONAL_ID", "OTHER_GOVERNMENT_ID"]);

/**
 * IdentityVerification — D4. One row per attempt (0..* per reservation).
 * For privacy only the last 4 characters of the ID number are stored; the
 * name on the ID and its expiry are checked but never persisted.
 */
export const IdentityVerification = sequelize.define(
  "IdentityVerification",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    reservationId: { type: DataTypes.INTEGER, allowNull: false },
    attemptNo: { type: DataTypes.INTEGER, allowNull: false },
    idType: { type: DataTypes.ENUM(...ID_TYPES), allowNull: false },
    idNumberLast4: { type: DataTypes.STRING(4), allowNull: false },
    result: { type: DataTypes.ENUM(...Object.values(VERIFICATION_RESULT)), allowNull: false },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
    verifiedBy: { type: DataTypes.INTEGER, allowNull: false },
    attemptedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "identity_verifications",
    updatedAt: false,
    indexes: [{ unique: true, fields: ["reservation_id", "attempt_no"] }],
  }
);
