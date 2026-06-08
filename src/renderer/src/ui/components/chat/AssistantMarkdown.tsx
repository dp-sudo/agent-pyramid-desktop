import {
  Children,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface AssistantMarkdownProps {
  text: string;
  streaming?: boolean;
}

export function AssistantMarkdown({ text, streaming }: AssistantMarkdownProps): ReactElement {
  return (
    <div className={`ds-markdown ${streaming ? "ds-shiny-markdown" : ""}`}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const external = isExternalHref(href);
    return (
      <a
        {...props}
        href={href}
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
    if (!src) return null;
    return (
      <span className="ds-markdown-image-frame">
        <img {...props} alt={alt ?? ""} loading="lazy" src={src} />
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
    return (
      <div className="ds-code-block">
        {language ? <div className="ds-code-block-header">{language}</div> : null}
        <pre {...props}>{children}</pre>
      </div>
    );
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

function extractCodeLanguage(children: ReactNode): string | null {
  const firstChild = Children.toArray(children)[0];
  if (!isValidElement<CodeElementProps>(firstChild)) return null;

  const match = /(?:^|\s)language-([\w-]+)/.exec(firstChild.props.className ?? "");
  return match?.[1] ?? null;
}

function isExternalHref(href: string | undefined): boolean {
  return href?.startsWith("http://") === true || href?.startsWith("https://") === true;
}
