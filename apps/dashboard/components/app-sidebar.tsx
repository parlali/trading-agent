"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { useAuthActions } from "@convex-dev/auth/react"
import {
    Gauge,
    LayoutDashboard,
    LogOut,
    Moon,
    Monitor,
    Plug,
    Power,
    Settings2,
    Sun,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar"

const mainItems = [
    { label: "Overview", href: "/", icon: LayoutDashboard },
    { label: "Test", href: "/test", icon: Plug },
    { label: "Strategies", href: "/strategies", icon: Settings2 },
]

const systemItems = [
    { label: "Kill Switches", href: "/system/kill-switches", icon: Power },
]

type NavItem = {
    label: string
    href: string
    icon: typeof LayoutDashboard
}

function NavItemRow({ item, pathname }: { item: NavItem, pathname: string }) {
    const isActive = item.href === "/"
        ? pathname === "/"
        : pathname.startsWith(item.href)
    const { setOpenMobile } = useSidebar()

    return (
        <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                <Link href={item.href} onClick={() => setOpenMobile(false)}>
                    <item.icon className="h-4 w-4" />
                    <span>{item.label}</span>
                </Link>
            </SidebarMenuButton>
        </SidebarMenuItem>
    )
}

const THEMES = [
    { value: "light", icon: Sun },
    { value: "dark", icon: Moon },
    { value: "system", icon: Monitor },
] as const

function ThemeSegment({ theme, setTheme }: { theme: string | undefined, setTheme: (t: string) => void }) {
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    return (
        <div className="flex rounded-md border border-border bg-muted/50 p-0.5">
            {THEMES.map(({ value, icon: Icon }) => (
                <button
                    key={value}
                    type="button"
                    onClick={(e) => { e.preventDefault(); setTheme(value) }}
                    className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors cursor-pointer",
                        mounted && theme === value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="capitalize">{value}</span>
                </button>
            ))}
        </div>
    )
}

export function AppSidebar() {
    const pathname = usePathname()
    const router = useRouter()
    const { theme, setTheme } = useTheme()
    const { signOut } = useAuthActions()

    async function handleSignOut() {
        await signOut()
        router.replace("/login")
    }

    return (
        <Sidebar>
            <SidebarHeader className="px-4 py-4 border-b border-sidebar-border">
                <Link href="/" className="flex items-center gap-2">
                    <Gauge className="h-5 w-5 text-primary" />
                    <span className="font-display text-sm font-semibold">Control Plane</span>
                </Link>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {mainItems.map((item) => (
                                <NavItemRow key={item.label} item={item} pathname={pathname} />
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup>
                    <SidebarGroupLabel>System</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {systemItems.map((item) => (
                                <NavItemRow key={item.label} item={item} pathname={pathname} />
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="px-4 pb-4 space-y-2">
                <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>Sign out</span>
                </button>
                <ThemeSegment theme={theme} setTheme={setTheme} />
            </SidebarFooter>
        </Sidebar>
    )
}
