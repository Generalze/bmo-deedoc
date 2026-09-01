"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Roles permitted to open each destination.
 *
 * The nav previously rendered all seventeen links to everyone. For a VALIDATOR
 * or PAYOUT_OFFICER — roles the admin sign-in deliberately admits — sixteen of
 * them hard-failed, and on six pages the resulting 403 also deleted the session
 * token, so one wrong click signed an operator out mid-shift. Filtering here
 * does not grant anything: the API remains the authority. It stops offering
 * doors that are locked.
 */
type NavRole = string;

type AdminNavGroup = {
  title: string;
  items: Array<{ href: string; label: string; roles: NavRole[] }>;
};

/** Command roles under the Ogun structure, plus the legacy ADMIN still in migration. */
const COMMAND = ["SUPER_ADMIN", "STATE_OFFICER", "COORDINATOR", "ADMIN"];
const SUPER_ONLY = ["SUPER_ADMIN"];

const groups: AdminNavGroup[] = [
  {
    title: "Core",
    items: [
      { href: "/admin/dashboard", label: "Overview", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/command", label: "Command Dashboard", roles: ["SUPER_ADMIN", "STATE_OFFICER", "COORDINATOR"] },
      {
        href: "/admin/pre-election",
        label: "Pre-Election",
        roles: [...COMMAND, "VALIDATOR", "PAYOUT_OFFICER"],
      },
      { href: "/admin/rewards", label: "Rewards", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/rewards/reconciliation", label: "Legacy Reconciliation", roles: SUPER_ONLY },
      { href: "/admin/activity", label: "Activity", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/reference", label: "Reference Data", roles: ["ADMIN", "SUPER_ADMIN"] },
      // Every signed-in operator has an account to manage.
      { href: "/admin/account", label: "Account", roles: [...COMMAND, "VALIDATOR", "PAYOUT_OFFICER"] },
    ],
  },
  {
    title: "Management",
    items: [
      { href: "/admin/manage", label: "Management", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/manage/territory", label: "Select Territory", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/manage/users", label: "Manage Users", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/manage/create", label: "Create User", roles: ["ADMIN", "SUPER_ADMIN"] },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { href: "/admin/operations/live", label: "Live Ops", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/operations/coverage", label: "Coverage", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/incidents", label: "Incidents", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/election-reports", label: "Election Reports", roles: ["ADMIN", "SUPER_ADMIN"] },
      { href: "/admin/evidence", label: "Evidence", roles: SUPER_ONLY },
      { href: "/admin/communications", label: "Communications", roles: ["ADMIN", "SUPER_ADMIN"] },
      // The election-day command board had no inbound link from any navigation:
      // its only route in was a footnote on a page that 403s for ADMIN.
      { href: "/election-day/situation-room", label: "Situation Room", roles: COMMAND },
    ],
  },
];

export function AdminNav({ role }: { role?: string | null }) {
  const pathname = usePathname();

  // Without a known role the nav shows everything, as it always did: a page
  // that has not yet passed its role down should not lose its navigation.
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: role ? group.items.filter((item) => item.roles.includes(role)) : group.items,
    }))
    .filter((group) => group.items.length > 0);

  return (
    <nav className="admin-nav">
      {visibleGroups.map((group) => (
        <section key={group.title} className="admin-nav__group">
          <p className="admin-nav__title">{group.title}</p>
          <div className="action-row admin-nav__links">
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`button ${pathname === item.href ? "" : "secondary"}`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}
