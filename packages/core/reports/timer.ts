import { DISCLOSURE_DAYS, REMINDER_DAYS } from "./constants.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const disclosureDeadline = (filedAt: string): string => new Date(Date.parse(filedAt) + DISCLOSURE_DAYS * DAY_MS).toISOString();

export const reminderFrom = (deadline: string): string => new Date(Date.parse(deadline) - REMINDER_DAYS * DAY_MS).toISOString();

export interface TimerState {
  disclosure_deadline: string;
  reminder_sent_at: string | null;
  expired_at: string | null;
  disclosed: boolean;
}

/** What the timer needs done at `now`; a disclosed report has nothing left to count down. */
export function timerAction(state: TimerState, now: string): "none" | "remind" | "expire" {
  if (state.disclosed || state.expired_at !== null) return "none";
  if (now >= state.disclosure_deadline) return "expire";
  if (state.reminder_sent_at === null && now >= reminderFrom(state.disclosure_deadline)) return "remind";
  return "none";
}

export function daysLeft(deadline: string, now: string): number {
  return Math.max(0, Math.ceil((Date.parse(deadline) - Date.parse(now)) / DAY_MS));
}
