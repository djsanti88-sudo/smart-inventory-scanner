import { redirect } from "next/navigation";

// Entry point: send users to the scan workflow. AuthGuard there redirects to /login if needed.
export default function Home() {
  redirect("/scan");
}
