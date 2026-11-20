/**
 * Model registry + associations (Figure 2, Class Diagram).
 * Foreign keys use ON DELETE RESTRICT so operational history (stays, bills,
 * payments, receipts) can never be silently removed.
 */
import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { User, ROLES } from "./userModel.js";
import { Guest } from "./Guest.js";
import { Room, ROOM_STATUS, ADMIN_SETTABLE_ROOM_STATUSES, READY_ROOM_STATUSES, HOUSEKEEPING_ROOM_STATUSES } from "./Room.js";
import { RoomType } from "./RoomType.js";
import { RoomStatusLog, STATUS_CHANGE_SOURCE } from "./RoomStatusLog.js";
import { HousekeepingTask, HOUSEKEEPING_TASK_STATUS } from "./HousekeepingTask.js";
import { IntegrationEvent } from "./IntegrationEvent.js";
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
import { ExternalRoomMapping, EXTERNAL_SYSTEMS } from "./ExternalRoomMapping.js";
import { ExternalBooking, EXTERNAL_SYNC_STATUS } from "./ExternalBooking.js";
import { PosOrder, POS_ORDER_STATUS, OPEN_POS_ORDER_STATUSES } from "./PosOrder.js";
import { StaffNotification, StaffNotificationRead, NOTIFICATION_CATEGORY, PROBLEM_NOTIFICATION_CATEGORIES } from "./StaffNotification.js";

const restrict = { onDelete: "RESTRICT", onUpdate: "CASCADE" };

// RoomType 1 — 0..* Room. rooms.room_type → room_types.name, so existing code keeps using the name.
RoomType.hasMany(Room, { foreignKey: "roomType", sourceKey: "name", as: "rooms", ...restrict });
Room.belongsTo(RoomType, { foreignKey: "roomType", targetKey: "name", as: "type", ...restrict });

/** A room type row is created the first time any room uses a new type name. */
const ensureRoomTypes = async (names, options = {}) => {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length) {
    await RoomType.bulkCreate(unique.map((name) => ({ name })), { ignoreDuplicates: true, transaction: options.transaction });
  }
};
Room.addHook("beforeCreate", (room, options) => ensureRoomTypes([room.roomType], options));
Room.addHook("beforeBulkCreate", (rooms, options) => ensureRoomTypes(rooms.map((r) => r.roomType), options));
Room.addHook("beforeUpdate", (room, options) => (room.changed("roomType") ? ensureRoomTypes([room.roomType], options) : undefined));
Room.addHook("beforeBulkUpdate", (options) => (options.attributes?.roomType ? ensureRoomTypes([options.attributes.roomType], options) : undefined));

// Room 1 — 0..* RoomStatusLog (audit trail of status transitions)
Room.hasMany(RoomStatusLog, { foreignKey: "roomId", as: "statusLogs", ...restrict });
RoomStatusLog.belongsTo(Room, { foreignKey: "roomId", as: "room", ...restrict });
RoomStatusLog.belongsTo(User, { foreignKey: "actorUserId", as: "actor", ...restrict });

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

// Room 1 — 0..* HousekeepingTask (references to tasks in the external Housekeeping System)
Room.hasMany(HousekeepingTask, { foreignKey: "roomId", as: "housekeepingTasks", ...restrict });
HousekeepingTask.belongsTo(Room, { foreignKey: "roomId", as: "room", ...restrict });
HousekeepingTask.belongsTo(Stay, { foreignKey: "stayId", as: "stay", ...restrict });

// IntegrationEvent 1 — 0..* IntegrationOutbox (one delivery row per receiving system)
IntegrationEvent.hasMany(IntegrationOutbox, { foreignKey: "integrationEventId", as: "deliveries", ...restrict });
IntegrationOutbox.belongsTo(IntegrationEvent, { foreignKey: "integrationEventId", as: "event", ...restrict });

// Room 1 — 0..* ExternalRoomMapping (at most one per external system; e.g. StayBook room id → PMS room)
Room.hasMany(ExternalRoomMapping, { foreignKey: "roomId", as: "externalMappings", ...restrict });
ExternalRoomMapping.belongsTo(Room, { foreignKey: "roomId", as: "room", ...restrict });
ExternalRoomMapping.belongsTo(User, { foreignKey: "createdBy", as: "creator", ...restrict });

// Reservation 1 — 0..1 ExternalBooking (the external system's ids, quote and revision for a synced booking)
Reservation.hasOne(ExternalBooking, { foreignKey: "reservationId", as: "externalBooking", ...restrict });
ExternalBooking.belongsTo(Reservation, { foreignKey: "reservationId", as: "reservation", ...restrict });

// Restaurant POS purchase notifications (review queue): the reservation the POS referred to,
// the in-house stay it was matched / approved for, and the folio charge created on approval.
PosOrder.belongsTo(Reservation, { foreignKey: "matchedReservationId", as: "reservation", ...restrict });
PosOrder.belongsTo(Stay, { foreignKey: "matchedStayId", as: "stay", ...restrict });
PosOrder.belongsTo(StayCharge, { foreignKey: "stayChargeId", as: "charge", ...restrict });
StayCharge.hasOne(PosOrder, { foreignKey: "stayChargeId", as: "posOrder", ...restrict });
PosOrder.belongsTo(User, { foreignKey: "reviewedBy", as: "reviewer", ...restrict });
PosOrder.belongsTo(User, { foreignKey: "adjustmentResolvedBy", as: "adjustmentResolver", ...restrict });

// Staff notifications (online reservations, sync problems) and per-user read state.
StaffNotification.belongsTo(Reservation, { foreignKey: "reservationId", as: "reservation", ...restrict });
StaffNotification.belongsTo(ExternalBooking, { foreignKey: "externalBookingId", as: "externalBooking", ...restrict });
StaffNotification.hasMany(StaffNotificationRead, { foreignKey: "notificationId", as: "reads", ...restrict });
StaffNotificationRead.belongsTo(StaffNotification, { foreignKey: "notificationId", as: "notification", ...restrict });
StaffNotificationRead.belongsTo(User, { foreignKey: "userId", as: "user", ...restrict });

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
  ["rooms", "status_changed_at", { type: DataTypes.DATE, allowNull: true }],
  ["integration_outbox", "integration_event_id", { type: DataTypes.INTEGER, allowNull: true }],
  ["integration_outbox", "last_response_status", { type: DataTypes.INTEGER, allowNull: true }],
];

const FOREIGN_KEY_UPGRADES = [
  ["rooms", "room_type", "room_types", "name", "fk_rooms_room_type"],
  ["integration_outbox", "integration_event_id", "integration_events", "id", "fk_outbox_integration_event"],
];

const hasForeignKey = async (table, column, refTable) => {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column AND REFERENCED_TABLE_NAME = :refTable LIMIT 1`,
    { replacements: { table, column, refTable } }
  );
  return rows.length > 0;
};

const enumSql = (values) => `ENUM(${values.map((v) => `'${v}'`).join(",")})`;

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

  // Room status lifecycle. Earlier versions stored VACANT / OCCUPIED / MAINTENANCE
  // plus a needs_cleaning flag; existing rooms are mapped onto the new statuses:
  //   VACANT + needs cleaning → DIRTY, VACANT + assigned confirmed reservation → RESERVED, other VACANT → AVAILABLE.
  // (needs_cleaning is left in place, unused, so no data is dropped.)
  const roomColumns = await describe("rooms");
  const statusType = String(roomColumns.status?.type || "");
  const wanted = Object.values(ROOM_STATUS);
  const hasValue = (value) => statusType.includes(`'${value}'`);
  if (!wanted.every(hasValue) || hasValue("VACANT")) {
    const superset = [...new Set(["VACANT", "OCCUPIED", "MAINTENANCE", ...wanted])];
    await sequelize.query(`ALTER TABLE rooms MODIFY status ${enumSql(superset)} NOT NULL DEFAULT '${ROOM_STATUS.AVAILABLE}'`);
    if (roomColumns.needs_cleaning) {
      await sequelize.query("UPDATE rooms SET status = 'DIRTY' WHERE status = 'VACANT' AND needs_cleaning = 1");
    }
    await sequelize.query(
      `UPDATE rooms r SET r.status = 'RESERVED'
        WHERE r.status = 'VACANT' AND EXISTS (SELECT 1 FROM reservations x WHERE x.room_id = r.id AND x.status = 'CONFIRMED')`
    );
    await sequelize.query("UPDATE rooms SET status = 'AVAILABLE' WHERE status = 'VACANT'");
    await sequelize.query(`ALTER TABLE rooms MODIFY status ${enumSql(wanted)} NOT NULL DEFAULT '${ROOM_STATUS.AVAILABLE}'`);
    applied.push("rooms.status (AVAILABLE/RESERVED/OCCUPIED/DIRTY/CLEANING/MAINTENANCE)");
  }

  // Integration source / target: fixed ENUMs → VARCHAR, so connecting a new system needs no schema change.
  for (const [table, column] of [["integration_requests", "source"], ["integration_outbox", "target"]]) {
    if (String((await describe(table))[column]?.type || "").startsWith("ENUM")) {
      await sequelize.query(`ALTER TABLE ${table} MODIFY ${column} VARCHAR(30) NOT NULL`);
      await sequelize.query(`UPDATE ${table} SET ${column} = 'BOOKING' WHERE ${column} = 'RESERVATIONS'`);
      applied.push(`${table}.${column} (VARCHAR; RESERVATIONS → BOOKING)`);
    }
  }

  // Room type catalogue, backfilled from the rooms' type names.
  const [[{ missing }]] = await sequelize.query(
    `SELECT COUNT(*) AS missing FROM (SELECT DISTINCT room_type FROM rooms) t
       LEFT JOIN room_types rt ON rt.name = t.room_type WHERE rt.id IS NULL`
  );
  if (Number(missing) > 0) {
    await sequelize.query("INSERT IGNORE INTO room_types (name, created_at, updated_at) SELECT DISTINCT room_type, NOW(), NOW() FROM rooms");
    applied.push(`room_types (+${missing} from rooms)`);
  }

  for (const [table, column, refTable, refColumn, name] of FOREIGN_KEY_UPGRADES) {
    if (!(await hasForeignKey(table, column, refTable))) {
      await sequelize.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable} (${refColumn}) ON DELETE RESTRICT ON UPDATE CASCADE`
      );
      applied.push(`${table}.${column} → ${refTable}.${refColumn} (FK)`);
    }
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
  READY_ROOM_STATUSES,
  HOUSEKEEPING_ROOM_STATUSES,
  RoomType,
  RoomStatusLog,
  STATUS_CHANGE_SOURCE,
  HousekeepingTask,
  HOUSEKEEPING_TASK_STATUS,
  IntegrationEvent,
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
  ExternalRoomMapping,
  EXTERNAL_SYSTEMS,
  ExternalBooking,
  EXTERNAL_SYNC_STATUS,
  PosOrder,
  POS_ORDER_STATUS,
  OPEN_POS_ORDER_STATUSES,
  StaffNotification,
  StaffNotificationRead,
  NOTIFICATION_CATEGORY,
  PROBLEM_NOTIFICATION_CATEGORIES,
};
