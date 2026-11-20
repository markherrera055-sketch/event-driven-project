/**
 * Registry of the external systems allowed to call the PMS, and what each one
 * may do. Credentials come from the environment (config.integrations.clients);
 * nothing secret lives in code.
 *
 * Authorization is scope-based: every integration route declares the scope it
 * needs, and a system's API key only carries the scopes listed here. A valid
 * key used on another system's endpoint is refused with 403 INSUFFICIENT_SCOPE.
 */
import { config } from "../../config/index.js";

export const SCOPES = Object.freeze({
  RESERVATIONS_READ: "reservations:read",
  RESERVATIONS_WRITE: "reservations:write",
  FOLIO_READ: "folio:read",
  ROOM_CHARGES_WRITE: "room_charges:write",
  ROOMS_READ: "rooms:read",
  HOUSEKEEPING_WRITE: "housekeeping:write",
  HOUSEKEEPING_TASKS_READ: "housekeeping_tasks:read",
  POS_ORDERS_WRITE: "pos_orders:write",
  POS_ORDERS_READ: "pos_orders:read",
});

export const CLIENTS = Object.freeze({
  BOOKING: {
    label: "Guest Booking System",
    member: 1,
    basePath: "/api/v1/integrations/booking",
    scopes: [SCOPES.RESERVATIONS_READ, SCOPES.RESERVATIONS_WRITE],
  },
  POS: {
    label: "Restaurant POS",
    member: 4,
    basePath: "/api/v1/integrations/pos",
    scopes: [SCOPES.FOLIO_READ, SCOPES.ROOM_CHARGES_WRITE, SCOPES.POS_ORDERS_WRITE, SCOPES.POS_ORDERS_READ],
  },
  HOUSEKEEPING: {
    label: "Housekeeping System",
    member: 3,
    basePath: "/api/v1/integrations/housekeeping",
    scopes: [SCOPES.ROOMS_READ, SCOPES.HOUSEKEEPING_WRITE],
  },
  HR: {
    label: "HR and Payroll System",
    member: 5,
    basePath: "/api/v1/integrations/hr",
    scopes: [SCOPES.HOUSEKEEPING_TASKS_READ],
  },
});

export const clientSettings = (source) => config.integrations.clients[source] || {};

/** Non-secret status of every integration, for the admin console. */
export const clientStatus = () =>
  Object.entries(CLIENTS).map(([source, c]) => {
    const s = clientSettings(source);
    return {
      source,
      label: c.label,
      member: c.member,
      basePath: c.basePath,
      scopes: c.scopes,
      enabled: !!s.apiKey,
      inboundSigned: !!s.inboundSecret,
      webhookConfigured: !!s.webhookUrl,
      webhookSigned: !!s.webhookSecret,
    };
  });
