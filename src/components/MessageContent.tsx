import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose-ekonomical">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? "");
            const text = String(children).replace(/\n$/, "");
            const isInline = !match && !text.includes("\n");
            if (isInline) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock language={match?.[1] ?? "text"} value={text} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative my-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between bg-muted px-3 py-1.5 text-xs">
        <span className="font-mono text-muted-foreground">{language}</span>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* noop */
            }
          }}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground transition hover:bg-background hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{ margin: 0, padding: "0.85rem 1rem", fontSize: "0.85rem", background: "transparent" }}
        PreTag="div"
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}
