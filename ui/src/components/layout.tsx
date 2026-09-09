import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { BookUserIcon, LogOutIcon, MenuIcon, SmartphoneIcon, UsersIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";

const NAV = [
  { to: "/", label: "Contacts", icon: BookUserIcon, end: true },
  { to: "/users", label: "Users", icon: UsersIcon },
  { to: "/setup", label: "Device setup", icon: SmartphoneIcon },
];

export function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )
          }
        >
          <item.icon className="size-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="bg-sidebar hidden w-60 shrink-0 flex-col border-r px-4 py-6 md:flex">
        <Brand />
        <div className="mt-8 flex-1">{nav}</div>
        <UserFooter username={user?.username ?? ""} onLogout={logout} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-40 flex h-14 items-center gap-3 border-b px-4 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon" aria-label="Toggle menu" onClick={() => setOpen((o) => !o)}>
            {open ? <XIcon /> : <MenuIcon />}
          </Button>
          <Brand compact />
        </header>
        {open && (
          <div className="bg-sidebar border-b p-4 md:hidden">
            {nav}
            <div className="mt-4">
              <UserFooter username={user?.username ?? ""} onLogout={logout} />
            </div>
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
        <BookUserIcon className="size-4" />
      </div>
      <div className="leading-tight">
        <div className="font-semibold">FlareCard</div>
        {!compact && <div className="text-muted-foreground text-xs">CardDAV admin</div>}
      </div>
    </div>
  );
}

function UserFooter({ username, onLogout }: { username: string; onLogout: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{username}</div>
        <div className="text-muted-foreground text-xs">Administrator</div>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onLogout} aria-label="Sign out" title="Sign out">
        <LogOutIcon />
      </Button>
    </div>
  );
}
