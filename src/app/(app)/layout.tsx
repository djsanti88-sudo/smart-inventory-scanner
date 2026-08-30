import { StoreHydrator } from "@/components/StoreHydrator";
import { AuthGuard } from "@/authentication/AuthGuard";
import { Nav } from "@/components/Nav";
import { ProdFirebaseBanner } from "@/components/ProdFirebaseBanner";
import { EmailVerifyBannerGate } from "@/authentication/EmailVerifyBannerGate";
import { BusinessContextProvider } from "@/components/BusinessContextGate";

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
