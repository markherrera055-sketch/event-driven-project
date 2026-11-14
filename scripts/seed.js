/**
 * Initial data for a new installation (run with `npm run migrate -- --seed`
 * or `npm run seed`). Inserts real rows through the models — it only runs on
 * empty tables, so it never overwrites live data.
 *
 * Staff passwords come from SEED_ADMIN_PASSWORD / SEED_RECEPTIONIST_PASSWORD;
 * when not set, random passwords are generated and printed ONCE.
 */
import crypto from "crypto";
import { Room, User, ROLES } from "../models/index.js";
import { hashPassword } from "../services/authService.js";

const ROOMS = [
  ["101", "Standard", 2, 2500],
  ["102", "Standard", 2, 2500],
  ["103", "Standard", 2, 2500],
  ["104", "Standard", 3, 2800],
  ["201", "Deluxe", 2, 3500],
  ["202", "Deluxe", 2, 3500],
  ["203", "Deluxe", 3, 3800],
  ["204", "Deluxe", 2, 3500],
  ["301", "Family", 4, 5200],
  ["302", "Family", 5, 5800],
  ["401", "Suite", 2, 7500],
];

const randomPassword = () => crypto.randomBytes(9).toString("base64url");

export async function seedInitialData({ log = () => {} } = {}) {
  if ((await Room.count()) === 0) {
    await Room.bulkCreate(ROOMS.map(([roomNumber, roomType, capacity, nightlyRate]) => ({ roomNumber, roomType, capacity, nightlyRate })));
    log(`✅ Seeded ${ROOMS.length} rooms`);
  } else {
    log("ℹ️  Rooms already exist — skipped");
  }

  if ((await User.count()) === 0) {
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || randomPassword();
    const deskPassword = process.env.SEED_RECEPTIONIST_PASSWORD || randomPassword();
    await User.create({ fullName: "System Administrator", username: "admin", role: ROLES.ADMINISTRATOR, passwordHash: await hashPassword(adminPassword) });
    await User.create({ fullName: "Front Desk", username: "frontdesk", role: ROLES.RECEPTIONIST, passwordHash: await hashPassword(deskPassword) });
    log("✅ Seeded staff accounts (change these passwords after first login):");
    log(`     Administrator  username: admin      password: ${process.env.SEED_ADMIN_PASSWORD ? "(from SEED_ADMIN_PASSWORD)" : adminPassword}`);
    log(`     Receptionist   username: frontdesk  password: ${process.env.SEED_RECEPTIONIST_PASSWORD ? "(from SEED_RECEPTIONIST_PASSWORD)" : deskPassword}`);
  } else {
    log("ℹ️  Staff accounts already exist — skipped");
  }
}

// Allow `node scripts/seed.js`
import { pathToFileURL } from "url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sequelize } = await import("../models/index.js");
  try {
    await seedInitialData({ log: console.log });
  } catch (err) {
    console.error("❌ Seeding failed:", err.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}
