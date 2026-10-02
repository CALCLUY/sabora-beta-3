import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "الأستاذ Vox — Gemini Live بالدارجة مع السبورة",
  description:
    "الأستاذ Vox — chatbot بالدارجة المغربية بالحروف العربية مع Gemini Live والسبورة التفاعلية، مبني على Darija Open Dataset.",
};

export const viewport: Viewport = {
  themeColor: "#090a0c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* Google Fonts: Playpen Sans Arabic (handwritten Arabic), Caveat & Playpen Sans & Patrick Hand & Kalam (handwritten French/Latin), IBM Plex Sans Arabic (UI) */}
        <link
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;500;600;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Kalam:wght@400;700&family=Patrick+Hand&family=Playpen+Sans+Arabic:wght@400;500;600;700;800&family=Playpen+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
