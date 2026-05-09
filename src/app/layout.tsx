import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CardIQ",
  description: "Personal credit card intelligence — spend, deals, and optimization.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
