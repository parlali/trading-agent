import { readdir, rm } from "node:fs/promises"
import path from "node:path"

const functionsDir = path.resolve(import.meta.dir, "..", "convex")
const generatedDir = path.join(functionsDir, "_generated")

function isGeneratedPath(filePath: string): boolean {
    const relativePath = path.relative(generatedDir, filePath)

    return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
}

function isRemovableArtifact(filePath: string): boolean {
    return (
        filePath.endsWith(".js") ||
        filePath.endsWith(".js.map") ||
        filePath.endsWith(".d.ts") ||
        filePath.endsWith(".d.ts.map")
    )
}

async function collectRemovableArtifacts(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const removablePaths: string[] = []

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name)

        if (isGeneratedPath(entryPath)) {
            continue
        }

        if (entry.isDirectory()) {
            removablePaths.push(...(await collectRemovableArtifacts(entryPath)))
            continue
        }

        if (isRemovableArtifact(entryPath)) {
            removablePaths.push(entryPath)
        }
    }

    return removablePaths
}

async function main(): Promise<void> {
    const removablePaths = await collectRemovableArtifacts(functionsDir)

    await Promise.all(removablePaths.map((filePath) => rm(filePath)))

    console.log(`Removed ${removablePaths.length} compiled Convex artifacts`)
}

await main()
