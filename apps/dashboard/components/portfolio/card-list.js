import { cn } from "@/lib/utils";
export function CardList({ data, getKey, renderCard, className, }) {
    return (<div className={cn("space-y-2", className)}>
            {data.map((item) => (<div key={getKey(item)}>{renderCard(item)}</div>))}
        </div>);
}
