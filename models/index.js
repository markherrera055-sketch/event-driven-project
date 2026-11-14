/**
 * Model registry + associations (Figure 2, Class Diagram).
 * Foreign keys use ON DELETE RESTRICT so operational history (stays, bills,
 * payments, receipts) can never be silently removed.
 */
import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { User, ROLES } from "./userModel.js";
import { Guest } from "./Guest.js";
import { Room, ROOM_STATUS, ADMIN_SETTABLE_ROOM_STATUSES } from "./Room.js";
import { Reservation, RESERVATION_STATUS, RESERVATION_SOURCE, ACTIVE_RESERVATION_STATUSES } from "./Reservation.js";
import { IdentityVerification, VERIFICATION_RESULT, ID_TYPES } from "./IdentityVerification.js";
import { Stay, STAY_STATUS } from "./Stay.js";
import { StayCharge, CHARGE_CATEGORIES } from "./StayCharge.js";
import { Bill, BILL_STATUS } from "./Bill.js";
import { BillAdjustment } from "./BillAdjustment.js";
import { Payment, PAYMENT_STATUS, PAYMENT_METHOD } from "./Payment.js";
import { Receipt } from "./Receipt.js";
import { IntegrationRequest, INTEGRATION_SOURCES } from "./IntegrationRequest.js";
import { IntegrationOutbox, OUTBOX_STATUS, OUTBOX_TARGETS } from "./IntegrationOutbox.js";
import { Session } from "./Session.js";

const restrict = { onDelete: "RESTRICT", onUpdate: "CASCADE" };

// Guest 1 — 0..* Reservation  ("makes")
Guest.hasMany(Reservation, { foreignKey: "guestId", as: "reservations", ...restrict });
Reservation.belongsTo(Guest, { foreignKey: "guestId", as: "guest", ...restrict });

// Room 1 — 0..* Reservation  ("books")
Room.hasMany(Reservation, { foreignKey: "roomId", as: "reservations", ...restrict });
Reservation.belongsTo(Room, { foreignKey: "roomId", as: "room", ...restrict });
Reservation.belongsTo(User, { foreignKey: "createdBy", as: "creator", ...restrict });
Room.belongsTo(User, { foreignKey: "lastCleanedBy", as: "cleaner", ...restrict });

// Reservation 1 — 0..* IdentityVerification  ("verifies")
Reservation.hasMany(IdentityVerification, { foreignKey: "reservationId", as: "verifications", ...restrict });
IdentityVerification.belongsTo(Reservation, { foreignKey: "reservationId", as: "reservation", ...restrict });
IdentityVerification.belongsTo(User, { foreignKey: "verifiedBy", as: "verifier", ...restrict });

// Reservation 1 — 0..1 Stay  ("becomes")
Reservation.hasOne(Stay, { foreignKey: "reservationId", as: "stay", ...restrict });
Stay.belongsTo(Reservation, { foreignKey: "reservationId", as: "reservation", ...restrict });
Stay.belongsTo(User, { foreignKey: "checkedInBy", as: "checkInStaff", ...restrict });
Stay.belongsTo(User, { foreignKey: "checkedOutBy", as: "checkOutStaff", ...restrict });

// Stay 1 — 0..* StayCharge  (guest folio, POS charges)
Stay.hasMany(StayCharge, { foreignKey: "stayId", as: "charges", ...restrict });
StayCharge.belongsTo(Stay, { foreignKey: "stayId", as: "stay", ...restrict });

// Stay 1 — 0..1 Bill  ("billed as")
Stay.hasOne(Bill, { foreignKey: "stayId", as: "bill", ...restrict });
Bill.belongsTo(Stay, { foreignKey: "stayId", as: "stay", ...restrict });
Bill.belongsTo(User, { foreignKey: "generatedBy", as: "generator", ...restrict });

// Bill 1 ◆— 0..* BillAdjustment  ("contains", composition)
Bill.hasMany(BillAdjustment, { foreignKey: "billId", as: "adjustments", onDelete: "CASCADE", onUpdate: "CASCADE" });
BillAdjustment.belongsTo(Bill, { foreignKey: "billId", as: "bill" });
BillAdjustment.belongsTo(User, { foreignKey: "adjustedBy", as: "adjuster", ...restrict });

// Bill 1 — 0..* Payment  ("paid by")
Bill.hasMany(Payment, { foreignKey: "billId", as: "payments", ...restrict });
Payment.belongsTo(Bill, { foreignKey: "billId", as: "bill", ...restrict });
Payment.belongsTo(User, { foreignKey: "receivedBy", as: "receiver", ...restrict });

// Payment 1 — 0..1 Receipt  ("issues")
Payment.hasOne(Receipt, { foreignKey: "paymentId", as: "receipt", ...restrict });
Receipt.belongsTo(Payment, { foreignKey: "paymentId", as: "payment", ...restrict });

/** v_bill_total (Figure 4): the authoritative amount due for every bill. */
export const BILL_TOTAL_VIEW_SQL = `
CREATE OR REPLACE VIEW v_bill_total AS
SELECT
  b.id AS bill_id,
  b.stay_id AS stay_id,
  b.room_charge AS room_charge,
  COALESCE((SELECT SUM(c.amount) FROM stay_charges c WHERE c.stay_id = b.stay_id), 0) AS charges_total,
  COALESCE((SELECT SUM(a.amount) FROM bill_adjustments a WHERE a.bill_id = b.id), 0) AS adjustments_total,
  b.room_charge
    + COALESCE((SELECT SUM(c.amount) FROM stay_charges c WHERE c.stay_id = b.stay_id), 0)
    + COALESCE((SELECT SUM(a.amount) FROM bill_adjustments a WHERE a.bill_id = b.id), 0) AS total_due
FROM bills b`;

/**
 * Columns added after the first release. sequelize.sync() creates missing
 * tables but never adds columns to existing ones, so existing databases are
 * upgraded here. Every step checks the live schema first: running it again is
 * a no-op, and no data is dropped.
 */
const COLUMN_UPGRADES = [
  ["users", "must_change_password", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }],
  ["users", "session_version", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }],
  ["users", "password_changed_at", { type: DataTypes.DATE, allowNull: true }],
  ["rooms", "floor", { type: DataTypes.STRING(10), allowNull: true }],
  ["rooms", "description", { type: DataTypes.STRING(1000), allowNull: true }],
  ["rooms", "amenities", { type: DataTypes.JSON, allowNull: true }],
  ["rooms", "archived_at", { type: DataTypes.DATE, allowNull: true }],
];

export async function upgradeSchema({ log = () => {} } = {}) {
  const qi = sequelize.getQueryInterface();
  const applied = [];
  const tables = {};
  const describe = async (table) => (tables[table] ??= await qi.describeTable(table));

  for (const [table, column, spec] of COLUMN_UPGRADES) {
    if (!(await describe(table))[column]) {
      await qi.addColumn(table, column, spec);
      applied.push(`${table}.${column}`);
    }
  }

  // rooms.status gained MAINTENANCE (ENUM values must be altered explicitly).
  const statusType = String((await describe("rooms")).status?.type || "");
  const wanted = Object.values(ROOM_STATUS);
  if (!wanted.every((value) => statusType.includes(`'${value}'`))) {
    await sequelize.query(
      `ALTER TABLE rooms MODIFY status ENUM(${wanted.map((v) => `'${v}'`).join(",")}) NOT NULL DEFAULT '${ROOM_STATUS.VACANT}'`
    );
    applied.push("rooms.status (+MAINTENANCE)");
  }

  for (const change of applied) log(`   + ${change}`);
  return applied;
}

/**
 * Creates missing tables, upgrades existing ones and (re)creates the view.
 * Non-destructive unless { fresh: true }, which drops and recreates
 * everything (development only).
 */
export async function syncSchema({ fresh = false, log } = {}) {
  if (fresh) {
    await sequelize.query("DROP VIEW IF EXISTS v_bill_total");
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
    try {
      await sequelize.sync({ force: true });
    } finally {
      await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
    }
  } else {
    await sequelize.sync();
    await upgradeSchema({ log });
  }
  await sequelize.query(BILL_TOTAL_VIEW_SQL);
}

export {
  sequelize,
  User,
  ROLES,
  Guest,
  Room,
  ROOM_STATUS,
  ADMIN_SETTABLE_ROOM_STATUSES,
  Reservation,
  RESERVATION_STATUS,
  RESERVATION_SOURCE,
  ACTIVE_RESERVATION_STATUSES,
  IdentityVerification,
  VERIFICATION_RESULT,
  ID_TYPES,
  Stay,
  STAY_STATUS,
  StayCharge,
  CHARGE_CATEGORIES,
  Bill,
  BILL_STATUS,
  BillAdjustment,
  Payment,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  Receipt,
  IntegrationRequest,
  INTEGRATION_SOURCES,
  IntegrationOutbox,
  OUTBOX_STATUS,
  OUTBOX_TARGETS,
  Session,
};
