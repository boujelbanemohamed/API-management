import { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';

export interface NavItem {
  label: string;
  to?: string;
  /** Écran prévu dans un lot ultérieur : affiché mais non cliquable. */
  soon?: string;
}
export interface NavGroup { label?: string; items: NavItem[] }

/** Menu latéral à groupes + barre supérieure, commun à la console et au portail. */
export function AppShell({ brand, menuLabel, groups, context }: { brand: string; menuLabel: string; groups: NavGroup[]; context?: ReactNode }) {
  const { username, logout } = useAuth();
  return (
    <div className="shell">
      <nav className="nav" aria-label={menuLabel}>
        <div className="nav-brand">{brand}</div>
        {groups.map((g, i) => (
          <div key={g.label ?? i} role="group" aria-label={g.label}>
            {g.label && <div className="nav-group" aria-hidden="true">{g.label}</div>}
            {g.items.map((it) =>
              it.to ? (
                <NavLink key={it.label} to={it.to} end={it.to === '/'}>{it.label}</NavLink>
              ) : (
                <span key={it.label} className="nav-soon" title={it.soon}>
                  {it.label}
                  <span className="pill">Bientôt</span>
                </span>
              ),
            )}
          </div>
        ))}
      </nav>
      <div className="main">
        <header className="topbar">
          {context}
          <span className="kpi-label">{username}</span>
          <button type="button" className="btn btn-secondary" onClick={logout}>Se déconnecter</button>
        </header>
        <main className="content" id="contenu">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
