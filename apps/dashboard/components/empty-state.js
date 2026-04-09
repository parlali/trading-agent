export function EmptyState({ icon: Icon, title, description, }) {
    return (<div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon className="h-10 w-10 text-muted-foreground/40"/>
            <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">{title}</p>
                <p className="text-xs text-muted-foreground/60">{description}</p>
            </div>
        </div>);
}
