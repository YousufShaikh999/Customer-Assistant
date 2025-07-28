'use client';

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});


export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.parent.postMessage(
        {
          type: "chatbot-state",
          url: window.location.href,
        },
        "*"
      );
    }
  }, [pathname]); // Runs whenever URL/path changes

  return (
    <html lang="en">
      <body
      >
        {children}
      </body>
    </html>
  );
}