// tokens first: globals.css and console.css both read from them.
import "./tokens.css";
import "./globals.css";
import "./console.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PICS Nigeria",
  description: "National political platform for voter engagement.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
