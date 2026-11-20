import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useOnline } from "../lib/hooks";
import { Banner } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

export const ADMIN_NAV: NavItem[] = [
  { to: "/admin", label: "Overview", icon: "◎" },
  { to: "/admin/visits", label: "Visits & tasks", icon: "☑" },
  { to: "/admin/tracking", label: "Live tracking", icon: "⌖" },
  { to: "/admin/farmers", label: "Farmers", icon: "♣" },
  { to: "/admin/products", label: "Products", icon: "▦" },
  { to: "/admin/staff", label: "Staff", icon: "☺" },
  { to: "/admin/reports", label: "Reports", icon: "▤" },
  { to: "/admin/settings", label: "Settings", icon: "⚙" },
  { to: "/admin/help", label: "How it works", icon: "?" },
];

export const STAFF_NAV: NavItem[] = [
  { to: "/staff", label: "My day", icon: "☀" },
  { to: "/staff/visits", label: "My visits", icon: "☑" },
  { to: "/staff/history", label: "History", icon: "↺" },
  { to: "/staff/profile", label: "Profile", icon: "☺" },
];

export function AppLayout({ nav, bottomNav }: { nav: NavItem[]; bottomNav?: boolean }) {
  const { me, settings, signOut } = useAuth();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const base = nav[0]!.to;
  const unread = me?.unread_notifications ?? 0;

  return (
    <div className={`app ${bottomNav ? "app-staff" : "app-admin"}`}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        {!bottomNav ? (
          <button className="icon-btn menu-btn" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            ☰
          </button>
        ) : null}
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={26} height={26} />
          <span>{settings.app_name || "KisanRoute"}</span>
          <span className="org muted">{settings.organization_name}</span>
        </div>
        <nav className="topnav" aria-label="Main">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === base}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <NavLink to={`${base}/notifications`} className="icon-btn bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
            🔔{unread ? <span className="count">{unread > 99 ? "99+" : unread}</span> : null}
          </NavLink>
          <span className="who" title={me?.profile.email}>
            {me?.profile.display_name}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {!bottomNav ? (
        <aside className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="Sections">
          <nav>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === base}>
                <span aria-hidden className="nav-ico">
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </aside>
      ) : null}
      {open ? <div className="scrim" onClick={() => setOpen(false)} aria-hidden /> : null}

      <main id="main" className="content" tabIndex={-1}>
        {!online ? <Banner kind="warn">You're offline. Data may be out of date and changes can't be saved until you reconnect.</Banner> : null}
        <Outlet />
      </main>

      {bottomNav ? (
        <nav className="bottomnav" aria-label="Main">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === base}>
              <span aria-hidden>{n.icon}</span>
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

export function Section({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}
