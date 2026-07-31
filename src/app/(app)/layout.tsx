import { StoreHydrator } from "@/components/StoreHydrator";
import { AuthGuard } from "@/components/AuthGuard";
import { BusinessContextGate } from "@/components/BusinessContextGate";
import { Nav } from "@/components/Nav";
import { ProdFirebaseBanner } from "@/components/ProdFirebaseBanner";

// Shell for all protected app pages. Hydrates the local store, gates on the demo login, and
// renders the navigation. Login lives outside this group so it is not gated.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <StoreHydrator>
      <AuthGuard>
        <ProdFirebaseBanner />
        <Nav />
        <BusinessContextGate>
          <main className="flex-1 bg-zinc-50">{children}</main>
        </BusinessContextGate>
      </AuthGuard>
    </StoreHydrator>
  );
}
