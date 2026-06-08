import {
  Children,
  isValidElement,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface AssistantMarkdownProps {
  text: string;
  streaming?: boolean;
}

export function AssistantMarkdown({ text, streaming }: AssistantMarkdownProps): ReactElement {
  const renderText = streaming ? closeDanglingCodeFence(text) : text;
  return (
    <div className={`ds-markdown ${streaming ? "ds-shiny-markdown" : ""}`}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {renderText}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const safeHref = normalizeMarkdownHref(href);
    if (!safeHref) return <>{children}</>;
    const external = isExternalHref(safeHref);
    return (
      <a
        {...props}
        href={safeHref}
        rel={external ? "noreferrer" : undefined}
        target={external ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  code({ node: _node, className, children, ...props }) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  hr({ node: _node, ...props }) {
    return <hr {...props} className="ds-markdown-divider" />;
  },
  img({ node: _node, alt, src, ...props }) {
    const safeSrc = normalizeMarkdownImageSrc(src);
    if (!safeSrc) return null;
    return (
      <span className="ds-markdown-image-frame">
        <img {...props} alt={alt ?? ""} loading="lazy" src={safeSrc} />
      </span>
    );
  },
  input({ node: _node, className, type, ...props }) {
    const classes =
      type === "checkbox"
        ? ["ds-markdown-task-checkbox", className].filter(Boolean).join(" ")
        : className;
    return <input {...props} className={classes} disabled={type === "checkbox"} type={type} />;
  },
  pre({ node: _node, children, ...props }) {
    const language = extractCodeLanguage(children);
    return <CodeBlock language={language} code={extractCodeText(children)} preProps={props}>{children}</CodeBlock>;
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="ds-markdown-table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

type CodeElementProps = ComponentPropsWithoutRef<"code"> & {
  className?: string;
};

function CodeBlock({
  children,
  code,
  language,
  preProps,
}: {
  children: ReactNode;
  code: string;
  language: string | null;
  preProps: ComponentPropsWithoutRef<"pre">;
}): ReactElement {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCode(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable.");
      }
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (error) {
      console.warn("[chat] failed to copy code block:", error);
      setCopyState("failed");
    }
  }

  return (
    <div className="ds-code-block">
      <div className="ds-code-block-header">
        <span>{language ?? t("chat.codeBlock")}</span>
        <button type="button" onClick={() => void copyCode()}>
          {copyState === "copied"
            ? t("chat.copyCodeDone")
            : copyState === "failed"
              ? t("chat.copyCodeFailed")
              : t("chat.copyCode")}
        </button>
      </div>
      <pre {...preProps}>{children}</pre>
    </div>
  );
}

function extractCodeLanguage(children: ReactNode): string | null {
  const firstChild = Children.toArray(children)[0];
  if (!isValidElement<CodeElementProps>(firstChild)) return null;

  const match = /(?:^|\s)language-([\w-]+)/.exec(firstChild.props.className ?? "");
  return match?.[1] ?? null;
}

export function extractCodeText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return extractCodeText(child.props.children);
      }
      return "";
    })
    .join("");
}

function isExternalHref(href: string | undefined): boolean {
  return href?.startsWith("http://") === true || href?.startsWith("https://") === true;
}

export function normalizeMarkdownHref(href: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (_error) {
    void _error;
    return null;
  }
}

function normalizeMarkdownImageSrc(src: string | undefined): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return trimmed;
    if (url.protocol === "data:" && isSafeImageDataUrl(trimmed)) return trimmed;
    return null;
  } catch (_error) {
    void _error;
    return null;
  }
}

function isSafeImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value);
}

export function closeDanglingCodeFence(text: string): string {
  const fenceCount = text
    .split("\n")
    .filter((line) => /^\s*```/.test(line))
    .length;
  return fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
}
