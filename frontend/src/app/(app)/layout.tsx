import { UpdateProgressOverlay } from "@/components/UpdateProgressOverlay";

// REVISION: app-layout-v1-update-overlay
const MODULE_REVISION = "app-layout-v1-update-overlay";
console.log(`[app-layout] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Pass-through layout for the authenticated app routes. Its only job is to mount
 * the desktop auto-update progress overlay once for every app page (dashboards,
 * settings, admin, splash) so update feedback shows wherever the user is.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <UpdateProgressOverlay />
    </>
  );
}
