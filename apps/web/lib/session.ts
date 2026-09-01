import type { AuthUserProfile } from "@pics-nigeria/shared";

/**
 * One session, one place.
 *
 * The app stored four separate tokens — member, admin, agent, candidate — and
 * pages picked whichever they knew about, taking the first that existed. Sign-out
 * removed only the key belonging to the page you happened to be on, so a stale
 * token from another role survived and the next page drove with the wrong
 * session. The resulting 403s read as data faults rather than as the wrong user.
 *
 * Every page now reads and writes here, so there is one key and no fallback to
 * disagree with. Anyone holding a pre-existing token signs in again, which is
 * the correct outcome for a product that has not shipped.
 */

const SESSION_KEY = "picsNigeriaSession";

export function saveSession(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_KEY, token);
}

export function readSession(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_KEY);
}

export function clearSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
}

/**
 * Where each role belongs after signing in.
 *
 * Command roles land on the command dashboard rather than the legacy overview:
 * STATE_OFFICER and COORDINATOR are first-class there, and previously landed on
 * /platform — a page with no navigation and a single sign-out button, despite
 * both being first-class on the command screens.
 */
export function homeForRole(role: AuthUserProfile["role"]): string {
  switch (role) {
    case "SUPER_ADMIN":
    case "STATE_OFFICER":
    case "COORDINATOR":
      return "/admin/command";
    case "ADMIN":
      return "/admin/dashboard";
    case "VALIDATOR":
    case "PAYOUT_OFFICER":
      return "/admin/pre-election";
    case "AGENT":
      return "/agent/dashboard";
    case "MEMBER":
    case "VOTER":
      return "/dashboard";
    default:
      return "/dashboard";
  }
}

/**
 * Roles that may still sign in.
 *
 * CANDIDATE is absent deliberately. In the Ogun model a candidate is a record
 * the organisation maintains, not an operator: the candidate schema takes a name
 * as a string, with no email and no password, and the phase-1 migration maps a
 * legacy CANDIDATE user to a candidate domain record rather than to a role.
 */
export const SIGN_IN_ROLES: AuthUserProfile["role"][] = [
  "SUPER_ADMIN",
  "STATE_OFFICER",
  "COORDINATOR",
  "VALIDATOR",
  "PAYOUT_OFFICER",
  "MEMBER",
  "ADMIN",
  "AGENT",
  "VOTER",
];

export function canSignIn(role: AuthUserProfile["role"]) {
  return SIGN_IN_ROLES.includes(role);
}
