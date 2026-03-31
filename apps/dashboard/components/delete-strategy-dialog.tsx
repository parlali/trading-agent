"use client"

import { useState } from "react"
import { useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"

type DeleteStrategyDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    strategyId: Id<"strategies">
    strategyName: string
    onDeleted: () => void
}

export function DeleteStrategyDialog({
    open,
    onOpenChange,
    strategyId,
    strategyName,
    onDeleted,
}: DeleteStrategyDialogProps) {
    const deleteStrategy = useMutation(api.mutations.deleteStrategy)
    const [deleting, setDeleting] = useState(false)

    async function handleDelete() {
        setDeleting(true)
        try {
            await deleteStrategy({ strategyId })
            toast.success(`Deleted "${strategyName}"`)
            onOpenChange(false)
            onDeleted()
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to delete strategy")
        } finally {
            setDeleting(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Delete Strategy</DialogTitle>
                    <DialogDescription>
                        This will permanently delete <strong>{strategyName}</strong>.
                        Run history and logs will remain but the strategy configuration will be gone.
                        This action cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={deleting}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={deleting}
                    >
                        {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
