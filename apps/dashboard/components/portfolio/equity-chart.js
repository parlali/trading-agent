"use client";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend, } from "recharts";
import { formatCurrency, formatCompactCurrency, formatTimestamp } from "@/lib/format";
import { ACTIVE_VENUE_APPS, VENUE_META } from "@/lib/constants";
export const TIME_RANGES = [
    { value: "24h", label: "24H" },
    { value: "7d", label: "7D" },
    { value: "30d", label: "30D" },
    { value: "90d", label: "90D" },
    { value: "all", label: "All" },
];
function formatXAxis(ts, range) {
    const date = new Date(ts);
    if (range === "24h") {
        return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
export function EquityChart({ data, timeRange, height = 400, }) {
    if (data.length === 0) {
        return (<div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
                No equity data available for this time range
            </div>);
    }
    return (<ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border"/>
                <XAxis dataKey="timestamp" tickFormatter={(ts) => formatXAxis(ts, timeRange)} className="text-xs" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}/>
                <YAxis tickFormatter={(v) => formatCompactCurrency(v)} className="text-xs" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} width={60}/>
                <RechartsTooltip contentStyle={{
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: "12px",
        }} labelFormatter={(ts) => formatTimestamp(ts)} formatter={(value) => [formatCurrency(value)]}/>
                <Legend />
                {ACTIVE_VENUE_APPS.map((app) => {
            const meta = VENUE_META[app];
            return (<Area key={app} type="monotone" dataKey={app} name={meta.shortLabel} stroke={meta.chartColor} fill={meta.chartColor} fillOpacity={0.1} strokeWidth={1.5} dot={false} connectNulls/>);
        })}
                <Area type="monotone" dataKey="total" name="Total" stroke="var(--foreground)" fill="var(--foreground)" fillOpacity={0.05} strokeWidth={2} dot={false} connectNulls/>
            </AreaChart>
        </ResponsiveContainer>);
}
