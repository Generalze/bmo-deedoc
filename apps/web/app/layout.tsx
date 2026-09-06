// tokens first: globals.css and console.css both read from them.
import "./tokens.css";
import "./globals.css";
import "./console.css";
import type { Metadata } from "next";
import { CallCenterProvider } from "../components/call-center";

export const metadata: Metadata = {
  title: "PICS Nigeria",
  description: "Ogun State election operations platform.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          Voice sits above the page tree so a call rings wherever the operator
          is. It previously lived inside one panel on the Situation Room, which
          is why an incoming call could only arrive as a notification about a
          call rather than as a call.

          The provider is inert without a session: no socket is opened and no
          microphone is touched until someone is signed in and actually calls.
        */}
        <CallCenterProvider>{children}</CallCenterProvider>
      </body>
    </html>
  );
}
