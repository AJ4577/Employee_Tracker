import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { isAdminRole } from "@kisanroute/shared";
import { useAuth } from "./lib/auth";
import { AppLayout, ADMIN_NAV, STAFF_NAV } from "./ui/Layout";
import { Banner, Button, Loading } from "./ui/ui";
import { AcceptInvitePage, LoginPage, MfaPage, PendingApprovalPage, RegisterPage } from "./pages/auth/AuthPages";
import { ApiError } from "./lib/api";
import { NotificationsPage } from "./pages/Notifications";

const Overview = lazy(() => import("./pages/admin/Overview"));
const Visits = lazy(() => import("./pages/admin/Visits"));
const VisitDetailAdmin = lazy(() => import("./pages/admin/VisitDetail"));
const Tracking = lazy(() => import("./pages/admin/Tracking"));
const Farmers = lazy(() => import("./pages/admin/Farmers"));
const FarmerDetail = lazy(() => import("./pages/admin/FarmerDetail"));
const Products = lazy(() => import("./pages/admin/Products"));
const Staff = lazy(() => import("./pages/admin/Staff"));
const Reports = lazy(() => import("./pages/admin/Reports"));
const Settings = lazy(() => import("./pages/admin/Settings"));
const Help = lazy(() => import("./pages/admin/Help"));
const MyDay = lazy(() => import("./pages/staff/MyDay"));
const MyVisits = lazy(() => import("./pages/staff/MyVisits"));
const StaffVisit = lazy(() => import("./pages/staff/StaffVisit"));
const Profile = lazy(() => import("./pages/staff/Profile"));

function Gate({ need, children }: { need: "admin" | "staff"; children: ReactNode }) {
  const { session, loading, me, meError, needsMfa, signOut } = useAuth();
  if (loading) return <Loading label="Signing you in…" />;
  if (!session) return <Navigate to="/login" replace />;
  // Email verified but registration form not finished yet.
  if (meError instanceof ApiError && meError.code === "no_profile") return <Navigate to="/register" replace />;
  if (meError || !me)
    return (
      <main className="auth-shell">
        <div className="auth-card stack">
          <Banner kind="error">{meError?.message ?? "Your account isn't set up. Ask your administrator to invite you."}</Banner>
          <Button variant="secondary" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  if (me.profile.status === "invited") return <Navigate to="/accept-invite" replace />;
  if (me.profile.status === "pending") return <PendingApprovalPage />;
  if (me.profile.status !== "active")
    return (
      <main className="auth-shell">
        <div className="auth-card stack">
          <Banner kind="error">This account is suspended. Contact your administrator.</Banner>
          <Button variant="secondary" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  if (needsMfa) return <Navigate to="/mfa" replace />;
  const admin = isAdminRole(me.profile.role);
  if (need === "admin" && !admin) return <Navigate to="/staff" replace />;
  if (need === "staff" && admin) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

function Home() {
  const { session, loading, me, meError, needsMfa } = useAuth();
  if (loading) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (meError instanceof ApiError && meError.code === "no_profile") return <Navigate to="/register" replace />;
  if (me?.profile.status === "pending") return <PendingApprovalPage />;
  if (needsMfa) return <Navigate to="/mfa" replace />;
  return <Navigate to={me && isAdminRole(me.profile.role) ? "/admin" : "/staff"} replace />;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/mfa" element={<MfaPage />} />
        <Route
          path="/admin"
          element={
            <Gate need="admin">
              <AppLayout nav={ADMIN_NAV} />
            </Gate>
          }
        >
          <Route index element={<Overview />} />
          <Route path="visits" element={<Visits />} />
          <Route path="visits/:id" element={<VisitDetailAdmin />} />
          <Route path="tracking" element={<Tracking />} />
          <Route path="farmers" element={<Farmers />} />
          <Route path="farmers/:id" element={<FarmerDetail />} />
          <Route path="products" element={<Products />} />
          <Route path="staff" element={<Staff />} />
          <Route path="reports" element={<Reports />} />
          <Route path="settings" element={<Settings />} />
          <Route path="help" element={<Help />} />
          <Route path="notifications" element={<NotificationsPage base="/admin" />} />
        </Route>
        <Route
          path="/staff"
          element={
            <Gate need="staff">
              <AppLayout nav={STAFF_NAV} bottomNav />
            </Gate>
          }
        >
          <Route index element={<MyDay />} />
          <Route path="visits" element={<MyVisits scope="open" />} />
          <Route path="visits/:id" element={<StaffVisit />} />
          <Route path="history" element={<MyVisits scope="history" />} />
          <Route path="profile" element={<Profile />} />
          <Route path="notifications" element={<NotificationsPage base="/staff" />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
