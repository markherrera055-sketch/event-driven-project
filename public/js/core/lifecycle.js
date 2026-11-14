/**
 * Reservation lifecycle stepper — the states of the State Machine Diagram
 * (Figure 13): Confirmed → Verifying Identity → Checked-In → Billing →
 * Awaiting Payment → Paid → Checked-Out.
 */
import { html } from "./ui.js";

const STEPS = ["Confirmed", "Identity verified", "Checked-in", "Billing", "Awaiting payment", "Paid", "Checked-out"];

/** Index of the current step for a reservation (with optional stay/bill). */
export function currentStep(reservation, stay = reservation.stay, bill = stay?.bill) {
  if (reservation.status === "CHECKED_OUT" || stay?.status === "CHECKED_OUT") return 7;
  if (bill?.status === "PAID") return 6;
  if (bill?.status === "CONFIRMED") return 4;
  if (reservation.status === "CHECKED_IN") return 3;
  if (reservation.identityVerified) return 2;
  return 1;
}

export function lifecycleStepper(reservation, stay, bill) {
  if (reservation.status === "CANCELLED") return html`<ol class="stepper"><li class="current"><div class="bubble">✕</div>Cancelled</li></ol>`;
  const current = currentStep(reservation, stay, bill);
  return html`<ol class="stepper" aria-label="Reservation progress">${STEPS.map((s, i) => {
    const cls = i < current ? "done" : i === current ? "current" : "";
    return html`<li class="${cls}"><div class="bubble">${i < current ? "✓" : i + 1}</div>${s}</li>`;
  })}</ol>`;
}
