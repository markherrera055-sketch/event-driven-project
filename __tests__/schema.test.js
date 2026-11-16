/** Schema upgrade for existing databases (npm run migrate) + password policy helpers. */
import { resetDatabase } from "./helpers/harness.js";
import { sequelize, upgradeSchema, Room } from "../models/index.js";
import { passwordProblems, generateTemporaryPassword } from "../utils/password.js";
import { addDays, today } from "../utils/dates.js";

beforeAll(resetDatabase);
afterAll(() => sequelize.close());

const dropForeignKey = async (table, column) => {
  const [rows] = await sequelize.query(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column AND REFERENCED_TABLE_NAME IS NOT NULL`,
    { replacements: { table, column } }
  );
  for (const { name } of rows) await sequelize.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`);
};

describe("upgradeSchema()", () => {
  test("upgrades a database created by an earlier version, mapping room statuses and keeping data", async () => {
    // A confirmed reservation assigned to room 102 (→ RESERVED after the upgrade).
    await sequelize.query("INSERT INTO guests (first_name, last_name, created_at, updated_at) VALUES ('Old', 'Guest', NOW(), NOW())");
    const [[{ id: guestId }]] = await sequelize.query("SELECT id FROM guests ORDER BY id DESC LIMIT 1");
    await sequelize.query(
      `INSERT INTO reservations (reservation_code, guest_id, room_id, room_type, check_in_date, check_out_date, num_guests, status, source, created_at, updated_at)
       SELECT 'RSV-OLD1', :guestId, id, room_type, :from, :to, 1, 'CONFIRMED', 'FRONT_DESK', NOW(), NOW() FROM rooms WHERE room_number = '102'`,
      { replacements: { guestId, from: addDays(today(), 3), to: addDays(today(), 4) } }
    );

    // Recreate the old shape: no new columns, VACANT/OCCUPIED statuses + needs_cleaning flag, no room_types link.
    await sequelize.query("ALTER TABLE rooms DROP COLUMN floor, DROP COLUMN description, DROP COLUMN amenities, DROP COLUMN archived_at, DROP COLUMN status_changed_at");
    await sequelize.query("ALTER TABLE rooms ADD COLUMN needs_cleaning TINYINT(1) NOT NULL DEFAULT 0");
    await sequelize.query("ALTER TABLE rooms MODIFY status ENUM('VACANT','OCCUPIED','AVAILABLE') NOT NULL DEFAULT 'VACANT'");
    await sequelize.query("UPDATE rooms SET status = 'VACANT'");
    await sequelize.query("UPDATE rooms SET needs_cleaning = 1 WHERE room_number = '101'");
    await sequelize.query("ALTER TABLE rooms MODIFY status ENUM('VACANT','OCCUPIED') NOT NULL DEFAULT 'VACANT'");
    await sequelize.query("ALTER TABLE users DROP COLUMN must_change_password, DROP COLUMN session_version, DROP COLUMN password_changed_at");
    await dropForeignKey("rooms", "room_type");
    await dropForeignKey("integration_outbox", "integration_event_id");
    await sequelize.query("ALTER TABLE integration_outbox DROP COLUMN integration_event_id, DROP COLUMN last_response_status");
    await sequelize.query("ALTER TABLE integration_outbox MODIFY target ENUM('POS','RESERVATIONS') NOT NULL");
    await sequelize.query("ALTER TABLE integration_requests MODIFY source ENUM('POS','RESERVATIONS') NOT NULL");
    await sequelize.query("DELETE FROM room_types");
    const [[{ n: roomsBefore }]] = await sequelize.query("SELECT COUNT(*) AS n FROM rooms");

    const applied = await upgradeSchema();
    expect(applied).toEqual(
      expect.arrayContaining([
        "users.must_change_password",
        "users.session_version",
        "users.password_changed_at",
        "rooms.floor",
        "rooms.description",
        "rooms.amenities",
        "rooms.archived_at",
        "rooms.status_changed_at",
        "integration_outbox.integration_event_id",
        "rooms.status (AVAILABLE/RESERVED/OCCUPIED/DIRTY/CLEANING/MAINTENANCE)",
        "integration_outbox.target (VARCHAR; RESERVATIONS → BOOKING)",
        "integration_requests.source (VARCHAR; RESERVATIONS → BOOKING)",
        "rooms.room_type → room_types.name (FK)",
      ])
    );
    expect(applied.some((a) => a.startsWith("room_types (+"))).toBe(true);
    expect(await Room.count()).toBe(roomsBefore);
    const [[user]] = await sequelize.query("SELECT must_change_password, session_version FROM users LIMIT 1");
    expect(user).toMatchObject({ must_change_password: 0, session_version: 0 });

    const status = async (n) => (await Room.findOne({ where: { roomNumber: n } })).status;
    expect(await status("101")).toBe("DIRTY"); // was VACANT + needs cleaning
    expect(await status("102")).toBe("RESERVED"); // was VACANT + assigned confirmed reservation
    expect(await status("204")).toBe("AVAILABLE");
    const [[{ types }]] = await sequelize.query("SELECT COUNT(*) AS types FROM room_types");
    expect(Number(types)).toBe(3);
  });

  test("running it again changes nothing", async () => {
    expect(await upgradeSchema()).toEqual([]);
  });
});

describe("password policy", () => {
  test.each([
    ["Harbor#Light2031", true],
    ["short#A1", false],
    ["NoSymbolHere2031", false],
    ["no#upper#case2031", false],
    ["NO#LOWER#CASE2031", false],
    ["NoDigits#Here!!", false],
    ["Password2031!", false],
    ["Welcome!2031", false],
    [`${"Aa1#".repeat(18)}x`, false], // 73 bytes
  ])("%s → acceptable: %s", (pw, ok) => {
    expect(passwordProblems(pw).length === 0).toBe(ok);
  });

  test("a password containing the username is refused", () => {
    expect(passwordProblems("Liza#Ramos2031", { username: "liza" })).toEqual(["Must not contain your username."]);
  });

  test("generated temporary passwords always satisfy the policy and differ", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(14);
      expect(passwordProblems(pw)).toEqual([]);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });
});
