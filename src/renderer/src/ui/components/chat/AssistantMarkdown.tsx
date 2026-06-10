import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT } from "../../preferences";

interface AssistantMarkdownProps {
  text: string;
  streaming?: boolean;
  codeBlockCollapseLineThreshold?: number;
}

export function AssistantMarkdown({
  text,
  streaming,
  codeBlockCollapseLineThreshold = CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
}: AssistantMarkdownProps): ReactElement {
  const renderText = streaming ? closeDanglingCodeFence(text) : text;
  const components = useMemo(
    () => createMarkdownComponents(codeBlockCollapseLineThreshold),
    [codeBlockCollapseLineThreshold],
  );
  return (
    <div className={`ds-markdown ${streaming ? "ds-shiny-markdown" : ""}`}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {renderText}
      </ReactMarkdown>
    </div>
  );
}

function createMarkdownComponents(codeBlockCollapseLineThreshold: number): Components {
  return {
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
          <img
            {...props}
            alt={alt ?? ""}
            decoding="async"
            loading="lazy"
            src={safeSrc}
          />
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
        <CodeBlock
          language={language}
          code={extractCodeText(children)}
          preProps={props}
          collapseLineThreshold={codeBlockCollapseLineThreshold}
        >
          {children}
        </CodeBlock>
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
}

type CodeElementProps = ComponentPropsWithoutRef<"code"> & {
  className?: string;
};

function CodeBlock({
  children,
  code,
  collapseLineThreshold,
  language,
  preProps,
}: {
  children: ReactNode;
  code: string;
  collapseLineThreshold: number;
  language: string | null;
  preProps: ComponentPropsWithoutRef<"pre">;
}): ReactElement {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const shouldStartCollapsed = isCodeBlockCollapsedByDefault(
    code,
    collapseLineThreshold,
  );
  const [collapsed, setCollapsed] = useState(shouldStartCollapsed);
  const [userControlledCollapsed, setUserControlledCollapsed] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const codeContentId = useId();
  const codeLineCount = countCodeLines(code);
  const copyLabel = t("chat.copyCode");

  useEffect(() => {
    setCollapsed((current) =>
      resolveNextCodeBlockCollapsedState({
        currentCollapsed: current,
        defaultCollapsed: shouldStartCollapsed,
        userControlled: userControlledCollapsed,
      }),
    );
  }, [shouldStartCollapsed, userControlledCollapsed]);

  useEffect(() => {
    return () => clearCopyResetTimer(copyResetTimerRef);
  }, []);

  async function copyCode(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable.");
      }
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      resetCopyStateLater();
    } catch (error) {
      console.warn("[chat] failed to copy code block:", error);
      setCopyState("failed");
      resetCopyStateLater();
    }
  }

  function resetCopyStateLater(): void {
    clearCopyResetTimer(copyResetTimerRef);
    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = null;
      setCopyState("idle");
    }, 1600);
  }

  return (
    <div className={collapsed ? "ds-code-block is-collapsed" : "ds-code-block"}>
      <div className="ds-code-block-header">
        <span>{language ?? t("chat.codeBlock")}</span>
        <div className="ds-code-block-actions">
          {shouldStartCollapsed ? (
            <button
              type="button"
              aria-controls={codeContentId}
              aria-expanded={!collapsed}
              onClick={() => {
                setUserControlledCollapsed(true);
                setCollapsed((current) => !current);
              }}
            >
              {collapsed ? t("chat.expandCode") : t("chat.collapseCode")}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => void copyCode()}
          >
            {copyState === "copied"
              ? t("chat.copyCodeDone")
              : copyState === "failed"
                ? t("chat.copyCodeFailed")
                : t("chat.copyCode")}
          </button>
        </div>
      </div>
      {collapsed ? (
        <div className="ds-code-block-collapse-note">
          {t("chat.collapsedCodePreview", { count: codeLineCount })}
        </div>
      ) : null}
      <pre {...preProps} id={codeContentId}>{children}</pre>
    </div>
  );
}

export function isCodeBlockCollapsedByDefault(
  code: string,
  lineThreshold = CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
): boolean {
  return countCodeLines(code) > lineThreshold;
}

export function resolveNextCodeBlockCollapsedState({
  currentCollapsed,
  defaultCollapsed,
  userControlled,
}: {
  currentCollapsed: boolean;
  defaultCollapsed: boolean;
  userControlled: boolean;
}): boolean {
  if (!defaultCollapsed) return false;
  return userControlled ? currentCollapsed : true;
}

export function shouldReplaceCopyResetTimer(timerId: number | null): timerId is number {
  return timerId !== null;
}

function clearCopyResetTimer(timerRef: { current: number | null }): void {
  const timerId = timerRef.current;
  if (!shouldReplaceCopyResetTimer(timerId)) return;
  window.clearTimeout(timerId);
  timerRef.current = null;
}

export function countCodeLines(code: string): number {
  if (!code) return 0;
  const normalized = code.endsWith("\n") ? code.slice(0, -1) : code;
  return normalized.split("\n").length;
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

export function normalizeMarkdownImageSrc(src: string | undefined): string | null {
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
