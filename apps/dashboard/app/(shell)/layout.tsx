"use client"

import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { AuthGuard } from "@/components/auth-guard"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"

const pageNames: Record<string, string> = {
    "/": "Overview",
    "/test": "Connection Tests",
    "/strategies": "Strategies",
    "/strategies/new": "New Strategy",
    "/system/kill-switches": "Kill Switches",
    "/system/health": "System Health",
    "/system/alerts": "Alerts",
    "/positions": "Positions",
    "/equity": "Equity",
    "/trades": "Trades",
    "/runs": "Runs",
}

function getPageTitle(pathname: string): string {
    if (pageNames[pathname]) return pageNames[pathname]

    if (pathname.match(/^\/strategies\/[^/]+\/edit$/)) return "Edit Strategy"
    if (pathname.match(/^\/strategies\/[^/]+$/)) return "Strategy"
    if (pathname.match(/^\/runs\/[^/]+$/)) return "Run Detail"

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
        <AuthGuard>
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
        </AuthGuard>
    )
}
