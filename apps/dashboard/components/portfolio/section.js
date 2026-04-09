import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
export function PortfolioSection({ title, count, headerRight, children, className, }) {
    return (<Card className={cn(className)}>
            {title ? (<CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-base">
                            {title}{count !== undefined ? ` (${count})` : ""}
                        </CardTitle>
                        {headerRight}
                    </div>
                </CardHeader>) : null}
            <CardContent className={title ? "pt-0" : "pt-6"}>
                {children}
            </CardContent>
        </Card>);
}
