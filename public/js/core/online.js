/** Shared wording and badges for StayBook online reservations and their notifications. */
import { html, badge, dateTime } from "./ui.js";

export const CATEGORY_LABEL = {
  ONLINE_RESERVATION_NEW: "New online reservation",
  ONLINE_RESERVATION_UPDATED: "Online reservation updated",
  ONLINE_RESERVATION_CANCELLED: "Online reservation cancelled",
  ROOM_CONFLICT: "Room conflict warning",
  SYNC_FAILED: "Synchronization failed",
};

export const categoryBadge = (category) => badge(category, CATEGORY_LABEL[category] || category);

const INBOUND_LABEL = { ACKNOWLEDGED: "Received", UPDATED: "Updated", CANCELLED: "Cancelled" };

/**
 * Synchronisation state in one badge, with the detail in a second line:
 * what StayBook last sent, and whether front-desk changes reached StayBook.
 */
export function syncBadge(sync) {
  if (!sync) return "";
  if (sync.health === "WEBHOOK_FAILED") {
    return html`${badge("WEBHOOK_FAILED", "StayBook not updated")}<div class="sub">${sync.outbound.event} failed after ${sync.outbound.attempts} attempts</div>`;
  }
  if (sync.health === "WEBHOOK_PENDING") {
    return html`${badge("WEBHOOK_PENDING", "Sending to StayBook")}<div class="sub">${sync.outbound.event}</div>`;
  }
  return html`${badge(sync.inbound, `Synced · ${INBOUND_LABEL[sync.inbound] || sync.inbound}`)}<div class="sub">${dateTime(sync.lastSyncedAt)}</div>`;
}

export const STATUS_TEXT = { CONFIRMED: "Confirmed", CHECKED_IN: "Checked in", CHECKED_OUT: "Checked out", CANCELLED: "Cancelled" };

export const EVENT_TEXT = {
  ReservationCreated: "Booking received",
  ReservationUpdated: "Booking changed",
  ReservationCancelled: "Booking cancelled",
  GuestCheckedIn: "Guest checked in",
  GuestCheckedOut: "Guest checked out",
};
