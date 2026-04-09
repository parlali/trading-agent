"use client";
import Markdown from "react-markdown";
export function MarkdownContent({ content }) {
    return (<div className="text-xs space-y-2 max-h-[200px] max-w-full overflow-auto bg-muted/50 rounded p-2">
            <Markdown components={components}>{content}</Markdown>
        </div>);
}
const components = {
    h1: (props) => (<h1 className="text-sm font-bold mt-3 mb-1" {...props}/>),
    h2: (props) => (<h2 className="text-xs font-bold mt-2.5 mb-1" {...props}/>),
    h3: (props) => (<h3 className="text-xs font-semibold mt-2 mb-0.5" {...props}/>),
    p: (props) => (<p className="text-xs leading-relaxed" {...props}/>),
    ul: (props) => (<ul className="list-disc pl-4 space-y-0.5" {...props}/>),
    ol: (props) => (<ol className="list-decimal pl-4 space-y-0.5" {...props}/>),
    li: (props) => (<li className="text-xs" {...props}/>),
    strong: (props) => (<strong className="font-semibold" {...props}/>),
    code: (props) => (<code className="font-mono bg-muted rounded px-1 py-0.5 text-[11px]" {...props}/>),
    pre: (props) => (<pre className="font-mono bg-muted rounded p-2 overflow-auto text-[11px]" {...props}/>),
    a: (props) => (<a className="text-primary underline underline-offset-2" target="_blank" rel="noopener noreferrer" {...props}/>),
    blockquote: (props) => (<blockquote className="border-l-2 border-border pl-2 text-muted-foreground italic" {...props}/>),
    hr: () => <hr className="border-border my-2"/>,
    table: (props) => (<div className="overflow-auto">
            <table className="text-xs w-full border-collapse" {...props}/>
        </div>),
    th: (props) => (<th className="border border-border px-2 py-1 text-left font-semibold bg-muted/50" {...props}/>),
    td: (props) => (<td className="border border-border px-2 py-1" {...props}/>),
};
