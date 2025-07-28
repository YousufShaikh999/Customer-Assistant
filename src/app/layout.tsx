'use client'; // Make sure this is at the top

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// ... keep the imports above as-is

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
  }, [pathname]);

  return (
    <html lang="en">
      <body
      >
        {children}
      </body>
    </html>
  );
}
