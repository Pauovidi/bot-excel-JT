import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display"
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-body"
});

export const metadata: Metadata = {
  title: "Clínica Dental Demo",
  description: "Demo full-stack para Excel, Google Sheets, Twilio WhatsApp y Google Calendar."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className={`${fraunces.variable} ${manrope.variable} bg-shell text-ink antialiased`}>
        {children}
      </body>
    </html>
  );
}
