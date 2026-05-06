import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CardIQ",
  description: "Personal credit card research & spend optimizer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
