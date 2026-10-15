import type { Metadata } from "next";
import { Archivo, Martian_Mono } from "next/font/google";
import "./globals.css";
import { StacksProvider } from "@/lib/providers/StacksProvider";

// Archivo carries both registers: expanded + heavy for display (wdth axis),
// regular width for reading. Martian Mono is for anything on-chain:
// principals, amounts, block heights, designators.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
});

const martianMono = Martian_Mono({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-martian",
});

export const metadata: Metadata = {
  title: "FlashStack — Flash Loans on Bitcoin",
  description: "Open flash-loan infrastructure on Stacks. Borrow STX or canonical sBTC with zero collateral and repay in the same transaction.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${archivo.variable} ${martianMono.variable}`}>
      <body className="min-h-screen bg-surface text-slate-100 antialiased font-sans">
        <StacksProvider>
          {children}
        </StacksProvider>
      </body>
    </html>
  );
}
