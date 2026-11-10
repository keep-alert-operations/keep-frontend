import type { Metadata } from "next";
import localFont from "next/font/local";
import "./theme.css";
import "./globals.css";
import "./design.css";
import "./styles/alerts.css";
import "./styles/presets.css";
import "./styles/dashboards.css";
import "./styles/incidents.css";
import "./styles/rules.css";
import "./styles/maintenance.css";
import "./styles/admin.css";
import "./styles/reports.css";
const geist = localFont({
  src: "../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2",
  variable: "--font-geist",
  display: "swap",
  weight: "100 900",
});
const geistMono = localFont({
  src: "../../node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
});
export const metadata: Metadata = {
  title: "Keep · Alert operations",
  description: "Internal alert and incident management",
};
const themeBootstrap = `try {
  document.documentElement.dataset.theme = localStorage.getItem("keep-theme") === "dark" ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = "light";
}`;
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className={`${geist.variable} ${geistMono.variable}`}>
        <a className="skip" href="#main-content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
