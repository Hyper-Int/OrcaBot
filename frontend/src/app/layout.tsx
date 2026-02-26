// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SplashTransitionOverlay } from "@/components/SplashTransitionOverlay";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OrcaBot - Agentic AI Orchestration",
  description:
    "Run AI agents in secure sandboxes. Multiplayer dashboards, built-in browser, secrets protection, and persistent background processes.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  other: {
    "theme-color": "#030a16",
  },
  openGraph: {
    title: "OrcaBot - Agentic AI Orchestration",
    description:
      "Run AI agents in secure sandboxes. Multiplayer dashboards, built-in browser, secrets protection, and persistent background processes.",
    url: "https://orcabot.com",
    siteName: "OrcaBot",
    images: [
      {
        url: "https://orcabot.com/og-image.png",
        width: 1200,
        height: 630,
        alt: "OrcaBot - Agentic AI Orchestration",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "OrcaBot - Agentic AI Orchestration",
    description:
      "Run AI agents in secure sandboxes. Multiplayer dashboards, built-in browser, secrets protection, and persistent background processes.",
    images: ["https://orcabot.com/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline script to prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var stored = localStorage.getItem('theme-storage');
                  var theme = 'midnight'; // default for first-time users
                  if (stored) {
                    var parsed = JSON.parse(stored);
                    theme = (parsed.state && parsed.state.theme) || 'midnight';
                  }
                  if (theme === 'dark' || theme === 'midnight') {
                    document.documentElement.classList.add(theme);
                  }
                  if (new URLSearchParams(window.location.search).get('egress') === '1') {
                    localStorage.setItem('orcabot_egress_enabled', '1');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
        style={{ backgroundColor: "#030a16" }}
      >
        <Providers>
          {children}
          <SplashTransitionOverlay />
        </Providers>
      </body>
    </html>
  );
}
