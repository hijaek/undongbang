import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./design.css";

export const metadata: Metadata = {
  title: "운동방",
  description: "함께 운동하고, 꾸준히 기록하는 우리 운동방.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};
export const viewport: Viewport = {width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#ffffff'};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
