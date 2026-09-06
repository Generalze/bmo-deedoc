import { redirect } from "next/navigation";

/**
 * The front door is /login, and only /login.
 *
 * This page was a fifth sign-in form left behind by the session consolidation.
 * It carried its own rules: it accepted only VOTER and MEMBER, told everyone
 * else "This login page is for members only" — which is not true of a
 * coordinator or a payout officer, whose accounts are perfectly valid — and
 * always routed to /dashboard instead of the role's own workspace. It also had
 * no field-duty step, so it could not have granted an agent a session that
 * satisfies the GPS gate even if it had let one through.
 *
 * Rather than teach a second door the same rules and risk them drifting apart
 * again, it forwards. /login already states that it is one sign-in for members,
 * coordinators, field agents and command staff, and it is the only place that
 * decides who may sign in and where they land.
 */
export default function HomePage() {
  redirect("/login");
}
