"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type AccessKey = "VOTER" | "REGISTER" | "POLLING_UNIT";

type AccessCard = {
  key: AccessKey;
  href: string;
  title: string;
  description: string;
  icon: string;
};

const accessCards: AccessCard[] = [
  {
    key: "VOTER",
    href: "/login",
    title: "Sign In",
    description: "Members, coordinators, field agents and command staff",
    icon: "S",
  },
  {
    key: "REGISTER",
    href: "/register",
    title: "Register",
    description: "Create a member account in Ogun State",
    icon: "R",
  },
  {
    key: "POLLING_UNIT",
    href: "/polling-units",
    title: "Find Polling Unit",
    description: "Confirm your polling unit location",
    icon: "P",
  },
];

function NigeriaFlag({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 3 2"
      className={className}
      aria-label="Nigerian flag"
      role="img"
    >
      <rect x="0" y="0" width="1" height="2" fill="#008751" />
      <rect x="1" y="0" width="1" height="2" fill="#ffffff" />
      <rect x="2" y="0" width="1" height="2" fill="#008751" />
    </svg>
  );
}

export function PublicAccessShell({
  currentAccess,
  brandSubtitle,
  authTitle,
  authDescription,
  children,
  footerNote,
}: {
  currentAccess?: AccessKey;
  brandSubtitle: string;
  authTitle: string;
  authDescription: string;
  children: ReactNode;
  footerNote?: ReactNode;
}) {
  return (
    <main className="starter-page">
      <div className="starter-page__bar" />

      <div className="starter-page__container">
        <section className="starter-page__brand">
          <div className="starter-page__brand-mark">
            <NigeriaFlag className="starter-page__flag" />
          </div>

          <div>
            <h1>PICS Nigeria</h1>
            <p>{brandSubtitle}</p>
          </div>
        </section>

        <section className="starter-auth-card">
          <div className="starter-auth-card__header">
            <h2>{authTitle}</h2>
            <p>{authDescription}</p>
          </div>

          {children}
        </section>

        <section className="starter-access">
          <p className="starter-access__label">Access portals</p>

          <div className="starter-access__list">
            {accessCards.map((card) => {
              const isActive = currentAccess === card.key;

              return (
                <Link
                  key={card.href}
                  href={card.href}
                  className={`starter-access-card${isActive ? " starter-access-card--active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                >
                  <div className="starter-access-card__icon" aria-hidden="true">
                    {card.icon}
                  </div>
                  <div>
                    <span>{card.title}</span>
                    <p>{isActive ? "Currently selected access portal" : card.description}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <Link href="/polling-units" className="starter-polling-card">
          <div className="starter-polling-card__icon" aria-hidden="true">
            P
          </div>
          <div>
            <span>Find your polling unit</span>
            <p>Search your polling unit by state, LGA, and ward</p>
          </div>
        </Link>

        {footerNote ? <p className="starter-page__footer">{footerNote}</p> : null}
      </div>
    </main>
  );
}
