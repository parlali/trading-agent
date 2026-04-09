import { Skeleton } from "@/components/ui/skeleton";
export function PageSkeleton({ count = 3, height = "h-16", spacing = "space-y-3", }) {
    return (<div className={spacing}>
            {Array.from({ length: count }).map((_, i) => (<Skeleton key={i} className={height}/>))}
        </div>);
}
