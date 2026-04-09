import { cn } from "@/lib/utils";
export function FilterBar({ items, selected, onSelect, getLabel, variant = "pills", }) {
    if (variant === "tabs") {
        return (<div className="flex rounded-md border border-border bg-muted/50 p-0.5">
                {items.map((item) => (<button key={String(item)} type="button" onClick={() => onSelect(item)} className={cn("rounded-sm px-3 py-1 text-xs font-medium transition-colors", selected === item
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground")}>
                        {getLabel(item)}
                    </button>))}
            </div>);
    }
    return (<div className="flex gap-2 flex-wrap">
            {items.map((item) => (<button key={String(item)} type="button" onClick={() => onSelect(item)} className={cn("rounded-md px-3 py-1 text-xs font-medium border transition-colors", selected === item
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:text-foreground")}>
                    {getLabel(item)}
                </button>))}
        </div>);
}
