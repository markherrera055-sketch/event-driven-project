/** Guest records (D1). Guests are created through reservations; staff can search, view history and update contact details. */
import { Op } from "sequelize";
import { Guest, Reservation } from "../models/index.js";
import { notFound } from "../utils/errors.js";
import { guestJSON, reservationJSON } from "./serializers.js";
import { pageMeta } from "../utils/http.js";

export async function searchGuests({ search, page, limit, offset }) {
  const where = {};
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [{ firstName: like }, { lastName: like }, { email: like }, { phone: like }];
  }
  const { rows, count } = await Guest.findAndCountAll({
    where,
    order: [["lastName", "ASC"], ["firstName", "ASC"]],
    limit,
    offset,
  });
  return { data: rows.map(guestJSON), meta: pageMeta({ page, limit }, count) };
}

export async function getGuest(id) {
  const guest = await Guest.findByPk(id, {
    include: [{ model: Reservation, as: "reservations", include: ["room", "stay"] }],
    order: [[{ model: Reservation, as: "reservations" }, "checkInDate", "DESC"]],
  });
  if (!guest) throw notFound("Guest");
  return { ...guestJSON(guest), reservations: guest.reservations.map(reservationJSON) };
}

export async function updateGuest(id, changes) {
  const guest = await Guest.findByPk(id);
  if (!guest) throw notFound("Guest");
  await guest.update(changes);
  return guestJSON(guest);
}

/**
 * Finds an existing guest record or creates one, to avoid duplicates:
 * match by email first, then by phone + last name. Missing contact
 * details on the existing record are filled in from the new data.
 */
export async function findOrCreateGuest({ firstName, lastName, email, phone }, transaction) {
  let guest = null;
  if (email) guest = await Guest.findOne({ where: { email }, transaction });
  if (!guest && phone) guest = await Guest.findOne({ where: { phone, lastName }, transaction });

  if (guest) {
    const fill = {};
    if (!guest.email && email) fill.email = email;
    if (!guest.phone && phone) fill.phone = phone;
    if (Object.keys(fill).length) await guest.update(fill, { transaction });
    return guest;
  }
  return Guest.create({ firstName, lastName, email: email || null, phone: phone || null }, { transaction });
}
