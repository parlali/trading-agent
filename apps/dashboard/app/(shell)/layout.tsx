"use client"

import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"

const pageNames: Record<string, string> = {
    "/": "Overview",
    "/equity": "Equity",
    "/venues/alpaca-options": "Alpaca Options",
    "/venues/polymarket": "Polymarket",
    "/venues/mt5": "MT5",
    "/strategies": "Strategies",
    "/runs": "Runs",
    "/trades": "Trades",
    "/positions": "Positions",
    "/system/kill-switches": "Kill Switches",
    "/system/health": "Health",
    "/system/alerts": "Alerts",
}

function getPageTitle(pathname: string): string {
    if (pageNames[pathname]) return pageNames[pathname]
    for (const [path, name] of Object.entries(pageNames)) {
        if (pathname.startsWith(path) && path !== "/") return name
    }
    return ""
}

export default function ShellLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const pathname = usePathname()
    const pageTitle = getPageTitle(pathname)

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
                <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3 md:px-4">
                    <SidebarTrigger className="-ml-1" />
                    <Separator orientation="vertical" className="mr-2 !h-4" />
                    {pageTitle ? (
                        <span className="text-sm font-medium text-muted-foreground">{pageTitle}</span>
                    ) : null}
                </header>
                <main className="flex-1 overflow-auto p-3 md:p-6">
                    {children}
                </main>
            </SidebarInset>
        </SidebarProvider>
    )
}
