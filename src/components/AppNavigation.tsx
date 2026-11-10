"use client";

import { useEffect, useRef } from "react";

export const TABS = ["Overview", "Spend", "Orders", "Vouchers", "Redemptions", "Offers", "Dining", "Chat", "Review", "Cards"] as const;
export type Tab = (typeof TABS)[number];

const GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: "Your everyday", tabs: ["Overview", "Spend", "Orders", "Vouchers"] },
  { label: "The good stuff", tabs: ["Redemptions", "Offers", "Dining", "Chat"] },
];
const PRIMARY: Tab[] = ["Overview", "Spend", "Redemptions", "Cards"];
const MORE: Tab[] = ["Orders", "Vouchers", "Offers", "Dining", "Chat", "Review"];
const LABELS: Partial<Record<Tab, string>> = { Overview: "Home", Redemptions: "Rewards" };
const DESCRIPTIONS: Partial<Record<Tab, string>> = {
  Orders: "Purchases & baskets", Vouchers: "Balances & drawdowns",
  Offers: "Deals worth keeping", Dining: "Find your next table", Chat: "Ask your card assistant", Review: "Check suggested matches",
};
const PATHS: Record<Tab, React.ReactNode> = {
  Overview: <path d="m3 10 9-7 9 7M5 9v11h14V9M9 20v-6h6v6" />,
  Spend: <path d="M4 20v-6m5 6V9m6 11v-9m5 9V4" />,
  Orders: <><path d="M4 7h16l-1 14H5L4 7Z" /><path d="M8 7V5a4 4 0 0 1 8 0v2" /></>,
  Vouchers: <><path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V6Z" /><path d="M15 6v12" strokeDasharray="2 3" /></>,
  Redemptions: <path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.7l6.2-.9L12 3Z" />,
  Offers: <><path d="M3 3h9l9 9-9 9-9-9V3Z" /><circle cx="8" cy="8" r="1" /></>,
  Dining: <><path d="M4 3v6a2 2 0 0 0 4 0V3M6 3v18M18 3c-4 2-4 8 0 9V3Zm0 9v9" /></>,
  Chat: <path d="M3 4h18v13h-8l-6 4v-4H3V4Z" />,
  Review: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  Cards: <><rect x="2" y="5" width="20" height="15" rx="3" /><path d="M2 10h20M6 15h3" /></>,
};

export function NavIcon({ tab }: { tab: Tab }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{PATHS[tab]}</svg>;
}

export function Brand({ inverse = false }: { inverse?: boolean }) {
  return <div className={`brand ${inverse ? "brand-inverse" : ""}`}>
    <span className="brand-mark"><NavIcon tab="Cards" /></span>
    <span className="brand-word">Card<span>IQ</span><small>A little more from every card.</small></span>
  </div>;
}

export default function AppNavigation({ tab, onNavigate, onSignOut, reviewCount, expiringCount }: {
  tab: Tab; onNavigate: (tab: Tab) => void; onSignOut: () => void;
  reviewCount: number; expiringCount: number;
}) {
  const drawer = useRef<HTMLDialogElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  // A native dialog provides focus trapping, Escape, and focus restoration.
  // Close it when crossing to desktop so its invisible modal cannot trap focus.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches && drawer.current?.open) {
        drawer.current.close();
        sidebar.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
      }
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  function go(next: Tab) {
    drawer.current?.close();
    onNavigate(next);
  }
  function badge(next: Tab) {
    const count = next === "Review" ? reviewCount : next === "Redemptions" ? expiringCount : 0;
    if (count <= 0) return null;
    return <span className="nav-badge" aria-label={next === "Review" ? `${count} matches awaiting review` : `${count} holdings expiring in the next 30 days`}>{count > 99 ? "99+" : count}</span>;
  }
  function item(next: Tab) {
    return <button key={next} type="button" onClick={() => go(next)} className="sidebar-link" aria-current={tab === next ? "page" : undefined}>
      <NavIcon tab={next} /><span>{LABELS[next] ?? next}</span>{badge(next)}
    </button>;
  }
  const moreActive = MORE.includes(tab);

  return <>
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside ref={sidebar} className="app-sidebar">
      <div className="sidebar-brand"><Brand inverse /></div>
      <nav aria-label="Main navigation" className="sidebar-groups">
        {GROUPS.map(group => <div key={group.label}>
          <div className="nav-eyebrow">{group.label}</div>
          {group.tabs.map(item)}
        </div>)}
      </nav>
      <div className="sidebar-footer">
        {item("Review")}{item("Cards")}
        <button type="button" onClick={onSignOut} className="sidebar-link sign-out"><span aria-hidden="true">↗</span><span>Sign out</span></button>
        <div className="sidebar-note"><span aria-hidden="true">✳</span> Make every swipe count.</div>
      </div>
    </aside>

    <header className="mobile-header">
      <Brand />
      <button type="button" className="profile-button" aria-label="Open account and more sections" aria-haspopup="dialog" onClick={() => drawer.current?.showModal()}>KP</button>
    </header>

    <nav aria-label="Phone navigation" className="mobile-nav">
      {PRIMARY.map(next => <button type="button" key={next} onClick={() => go(next)} aria-current={tab === next ? "page" : undefined}>
        <span className="mobile-nav-icon"><NavIcon tab={next} />{badge(next)}</span>
        <span>{LABELS[next] ?? next}</span>
      </button>)}
      <button type="button" onClick={() => drawer.current?.showModal()} aria-haspopup="dialog" aria-current={moreActive ? "page" : undefined}>
        <span className="mobile-nav-icon"><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>{reviewCount > 0 && <span className="nav-dot" aria-label={`${reviewCount} matches awaiting review`} />}</span>
        <span>More</span>
      </button>
    </nav>

    <dialog ref={drawer} className="more-drawer" aria-labelledby="more-title"
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}
      onClick={event => { if (event.target === event.currentTarget) drawer.current?.close(); }}>
      <div className="drawer-content">
        <div className="drawer-handle" aria-hidden="true" />
        <div className="flex items-center justify-between gap-4 mb-5"><div><p className="eyebrow">YOUR CARDIQ</p><h2 id="more-title" className="font-serif text-3xl mt-1">A little more.</h2></div>
          <button type="button" autoFocus onClick={() => drawer.current?.close()} className="close-button" aria-label="Close more sections">×</button>
        </div>
        <nav aria-label="More sections" className="more-grid">
          {MORE.map(next => <button type="button" key={next} onClick={() => go(next)} aria-current={tab === next ? "page" : undefined}>
            <span className={`more-icon more-icon-${next.toLowerCase()}`}><NavIcon tab={next} /></span>
            <span><strong>{next}</strong><small>{DESCRIPTIONS[next]}</small></span>{badge(next)}
          </button>)}
        </nav>
        <button type="button" onClick={onSignOut} className="drawer-signout">Sign out of cardIQ <span aria-hidden="true">↗</span></button>
      </div>
    </dialog>
  </>;
}
