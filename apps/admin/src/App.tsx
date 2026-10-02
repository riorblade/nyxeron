import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import {
  Boxes,
  Building2,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings as Cog,
  Users as UsersIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, setToken, type Role } from "./api";
import { Audit } from "./pages/Audit";
import { Stock } from "./pages/Stock";
import { Venues } from "./pages/Venues";
import { Overview } from "./pages/Overview";
import { Settings } from "./pages/Settings";
import { UserPage } from "./pages/UserPage";
import { Users } from "./pages/Users";
import { cn } from "./ui/cn";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID;

export function App() {
  if (!APP_ID) return <Center>VITE_PRIVY_APP_ID is not set.</Center>;
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["email", "google"],
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        appearance: {
          theme: "dark",
          accentColor: "#ffffff",
          landingHeader: "NYXERON Back Office",
        },
      }}
    >
      <Gate />
    </PrivyProvider>
  );
}

/** Signed in with Privy, then the api says whether this email is an owner, admin or viewer. */
function Gate() {
  const { ready, authenticated, login, logout, getAccessToken, user } =
    usePrivy();
  const [me, setMe] = useState<{ email: string; role: Role } | "denied" | null>(
    null,
  );
  useEffect(() => {
    if (!authenticated) return;
    setToken(getAccessToken);
    let live = true;
    api<{ email: string; role: Role }>("GET", "/admin/me")
      .then((m) => live && setMe(m))
      .catch(() => live && setMe("denied"));
    return () => {
      live = false;
    };
  }, [authenticated, getAccessToken, user?.id]);

  if (!ready) return <Center>Loading…</Center>;
  if (!authenticated)
    return (
      <Center>
        <h1 className="text-2xl font-medium tracking-[-0.02em]">
          NYXERON Back Office
        </h1>
        <p className="mt-2 text-sm text-white/60">Staff only.</p>
        <button className="btn btn-primary mt-6 w-48" onClick={login}>
          Sign in
        </button>
      </Center>
    );
  if (!me) return <Center>Checking access…</Center>;
  if (me === "denied")
    return (
      <Center>
        <h1 className="text-xl font-medium">No access</h1>
        <p className="mt-2 max-w-xs text-sm text-white/60">
          This account isn&apos;t a back-office admin. Ask an owner to add your
          email.
        </p>
        <button className="btn mt-6" onClick={logout}>
          Sign out
        </button>
      </Center>
    );
  return <Shell email={me.email} role={me.role} logout={logout} />;
}

/** Hash routes: #/, #/users, #/users/<id>, #/audit, #/settings. */
function useRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
}

const NAV = [
  { path: "", label: "Overview", Icon: LayoutDashboard },
  { path: "users", label: "Players", Icon: UsersIcon },
  { path: "venues", label: "Venues", Icon: Building2 },
  { path: "stock", label: "Stock", Icon: Boxes },
  { path: "audit", label: "Audit log", Icon: ScrollText },
  { path: "settings", label: "Settings", Icon: Cog },
];

function Shell({
  email,
  role,
  logout,
}: {
  email: string;
  role: Role;
  logout: () => Promise<void>;
}) {
  const [page = "", id] = useRoute();
  const canEdit = role !== "viewer";
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-1 border-b border-white/10 p-3 md:w-56 md:border-r md:border-b-0 md:p-4">
        <div className="mb-3 px-2 text-sm font-medium tracking-[0.3em]">
          NYXERON
          <div className="label mt-1 tracking-[0.2em]">Back office</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(({ path, label, Icon }) => (
            <a
              key={path}
              href={`#/${path}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-white/65 hover:bg-white/8 hover:text-white",
                page === path && "bg-white/10 text-white",
              )}
            >
              <Icon className="size-4" /> {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-3 px-2 pt-2 text-xs text-white/50 md:mt-auto md:block md:pt-6">
          <div className="min-w-0 truncate" title={email}>
            {email}
          </div>
          <div className="label mt-1">{role}</div>
          <button
            className="mt-3 flex items-center gap-1.5 hover:text-white"
            onClick={logout}
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        {page === "" && <Overview />}
        {page === "users" &&
          (id ? <UserPage id={id} canEdit={canEdit} /> : <Users />)}
        {page === "venues" && <Venues canEdit={canEdit} />}
        {page === "stock" && <Stock canEdit={canEdit} />}
        {page === "audit" && <Audit />}
        {page === "settings" && <Settings role={role} />}
      </main>
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="panel flex w-full max-w-sm flex-col items-center p-8 text-center">
        {children}
      </div>
    </main>
  );
}
