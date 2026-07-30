import type { Metadata } from "next";
import { SpeedInsightsTelemetry } from "@/components/SpeedInsightsTelemetry";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Inventory Scanner",
  description: "Private smart barcode inventory scanner. Scan, match, count, export.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <SpeedInsightsTelemetry />
      </body>
    </html>
  );
}
