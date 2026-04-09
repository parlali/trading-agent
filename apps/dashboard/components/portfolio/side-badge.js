import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
export function SideBadge({ side, className, }) {
    return (<Badge variant={side === "long" ? "default" : "destructive"} className={cn("text-xs", className)}>
            {side}
        </Badge>);
}
