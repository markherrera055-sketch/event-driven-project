import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/** Guest — D1 Guests. One guest makes 0..* reservations. */
export const Guest = sequelize.define(
  "Guest",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    firstName: { type: DataTypes.STRING(80), allowNull: false },
    lastName: { type: DataTypes.STRING(80), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
  },
  {
    tableName: "guests",
    indexes: [{ fields: ["last_name", "first_name"] }, { fields: ["email"] }, { fields: ["phone"] }],
  }
);

Guest.prototype.getFullName = function getFullName() {
  return `${this.firstName} ${this.lastName}`;
};
