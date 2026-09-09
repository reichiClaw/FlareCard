import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "@/components/layout";
import { useAuth } from "@/lib/auth";
import { LoginPage } from "@/pages/login";
import { ContactsPage } from "@/pages/contacts";
import { UsersPage } from "@/pages/users";
import { SetupPage } from "@/pages/setup";
import { Skeleton } from "@/components/ui/skeleton";

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-64 space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route index element={<ContactsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="setup" element={<SetupPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
