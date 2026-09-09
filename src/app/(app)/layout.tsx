import { StoreHydrator } from "@/sync-database/StoreHydrator";
import { AuthGuard } from "@/authentication/AuthGuard";
import { Nav } from "@/user-interface/shell/Nav";
import { ProdFirebaseBanner } from "@/user-interface/shell/ProdFirebaseBanner";
import { EmailVerifyBannerGate } from "@/authentication/EmailVerifyBannerGate";
import { BusinessContextProvider } from "@/users-businesses/BusinessContextGate";

// Shell for all protected app pages. Hydrates the local store, gates on the demo login, and
// renders the navigation. Login lives outside this group so it is not gated.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <StoreHydrator>
      <AuthGuard>
        <BusinessContextProvider>
          <ProdFirebaseBanner />
          <EmailVerifyBannerGate />
          <Nav />
          <main className="flex-1 bg-zinc-50">{children}</main>
        </BusinessContextProvider>
      </AuthGuard>
    </StoreHydrator>
  );
}
