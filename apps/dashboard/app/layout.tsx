export const dynamic = "force-dynamic"

import type { Metadata } from "next"
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google"
import { ConvexClientProvider } from "@/components/convex-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "sonner"
import "./globals.css"

const jakarta = Plus_Jakarta_Sans({
    subsets: ["latin"],
    variable: "--font-sans",
    display: "swap",
})

const jetbrainsMono = JetBrains_Mono({
    subsets: ["latin"],
    variable: "--font-mono",
    display: "swap",
})

export const metadata: Metadata = {
    title: "Trading Control Plane",
    description: "Multi-venue trading strategy control plane",
}

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className={`${jakarta.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
                <ThemeProvider>
                    <ConvexClientProvider>
                        <TooltipProvider>
                            {children}
                        </TooltipProvider>
                    </ConvexClientProvider>
                </ThemeProvider>
                <Toaster />
            </body>
        </html>
    )
}
