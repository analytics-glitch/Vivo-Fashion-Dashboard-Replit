import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { CaretRight } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { PRIMARY_NAV, ADMIN_NAV, HOME_GROUP_ORDER } from "@/lib/navItems";

/**
 * Home landing page (route "/"). A grouped grid of nav tiles — one card per
 * destination the signed-in user can actually reach. The top-nav and this page
 * share the same nav definition (lib/navItems.jsx) so they never drift.
 */
const Tile = ({ item }) => {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      data-testid={`home-tile-${item.id}`}
      className="group card-white p-4 flex items-start gap-3 transition-all hover:-translate-y-0.5 hover:shadow-md hover:border-brand/50"
    >
      <span className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-brand/10 text-brand">
        <Icon size={20} weight="duotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 font-bold text-[14px] text-foreground leading-tight">
          {item.label}
          <CaretRight
            size={13}
            className="text-muted opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0"
          />
        </span>
        {item.desc && (
          <span className="block text-muted text-[12px] mt-1 leading-snug">{item.desc}</span>
        )}
      </span>
    </Link>
  );
};

export default function Home() {
  const { user } = useAuth();

  const groups = useMemo(() => {
    const accessible = [
      ...PRIMARY_NAV.filter((t) => canAccessPage(user, t.id)),
      // Admin tiles still go through canAccessPage so visibility matches the
      // route-level gate exactly (admin routes require both adminOnly + pageId,
      // and allowed_pages overrides can narrow what an admin actually sees).
      ...(user?.role === "admin" ? ADMIN_NAV.filter((t) => canAccessPage(user, t.id)) : []),
    ];
    const byGroup = new Map();
    for (const item of accessible) {
      if (!byGroup.has(item.group)) byGroup.set(item.group, []);
      byGroup.get(item.group).push(item);
    }
    return HOME_GROUP_ORDER
      .filter((g) => byGroup.has(g))
      .map((g) => ({ title: g, items: byGroup.get(g) }));
  }, [user]);

  const firstName = (user?.name || user?.email || "").split(/[\s@]/)[0];

  return (
    <div className="space-y-8" data-testid="home-page">
      <div>
        <div className="eyebrow">Vivo Fashion Group · BI</div>
        <h1 className="font-extrabold tracking-tight mt-1 leading-[1.15] text-[clamp(22px,3vw,30px)]">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="text-muted text-[13.5px] mt-1">
          Choose a workspace to dive into. You only see the areas you have access to.
        </p>
      </div>

      {groups.map((group) => (
        <section key={group.title} data-testid={`home-group-${group.title}`}>
          <h2 className="font-bold text-[12.5px] uppercase tracking-wider text-muted mb-3">
            {group.title}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {group.items.map((item) => (
              <Tile key={item.id} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
