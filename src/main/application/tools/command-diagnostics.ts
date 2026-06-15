import * as path from "node:path";
import ts from "typescript";
import { isPathInsideOrEqual, isSamePath } from "../path-utils.js";
import { toWorkspaceRelative } from "./workspace-policy.js";

export interface WorkspaceDiagnostic {
  path: string;
  line: number;
  column: number;
  code: string;
  severity: "error" | "warning" | "suggestion" | "message";
  message: string;
  source: "typecheck" | "language_service";
}

export interface WorkspaceSymbol {
  path: string;
  name: string;
  kind: string;
  kindModifiers: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  level: number;
}

/**
 * Converts TypeScript CLI output into workspace-relative diagnostics. Entries
 * outside the active workspace are omitted so command output cannot surface
 * escaped paths as structured diagnostics.
 */
export function parseTypeScriptDiagnostics(
  output: string,
  workspace: string,
  diagnosticBasePath: string,
): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    const fullPath = path.resolve(diagnosticBasePath, match[1]);
    const relativePath = workspaceRelativeDiagnosticPath(workspace, fullPath);
    if (!relativePath) continue;
    diagnostics.push({
      path: relativePath,
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      severity: "error",
      message: match[5],
      source: "typecheck",
    });
  }
  return diagnostics;
}

/**
 * Runs a short-lived TypeScript Language Service for one workspace file. The
 * caller owns workspace path validation; this function only shapes diagnostics
 * and filters any file path that resolves outside the workspace root.
 */
export async function collectLanguageServiceDiagnostics(
  workspace: string,
  filePath: string,
): Promise<WorkspaceDiagnostic[]> {
  const service = createFileLanguageService(workspace, filePath);
  const diagnostics = [
    ...service.getSyntacticDiagnostics(filePath),
    ...service.getSemanticDiagnostics(filePath),
    ...service.getSuggestionDiagnostics(filePath),
  ];
  service.dispose();
  return diagnostics.flatMap((diagnostic) => {
    const workspaceDiagnostic = toWorkspaceDiagnostic(diagnostic, workspace, filePath);
    return workspaceDiagnostic ? [workspaceDiagnostic] : [];
  });
}

/**
 * Returns a TypeScript navigation outline for one workspace file. This gives
 * coding tools a structured pre-edit map without introducing a persistent LSP
 * server or repository-wide symbol index.
 */
export async function collectFileSymbols(
  workspace: string,
  filePath: string,
  maxSymbols: number,
): Promise<{ symbols: WorkspaceSymbol[]; truncated: boolean }> {
  const service = createFileLanguageService(workspace, filePath);
  try {
    const sourceFile = service.getProgram()?.getSourceFile(filePath) ??
      ts.createSourceFile(
        filePath,
        ts.sys.readFile(filePath) ?? "",
        ts.ScriptTarget.Latest,
        true,
      );
    const relativePath = workspaceRelativeDiagnosticPath(workspace, filePath);
    if (!relativePath) return { symbols: [], truncated: false };
    const tree = service.getNavigationTree(filePath);
    const symbols: WorkspaceSymbol[] = [];
    collectNavigationSymbols(tree, sourceFile, relativePath, symbols, maxSymbols + 1, 0);
    return {
      symbols: symbols.slice(0, maxSymbols),
      truncated: symbols.length > maxSymbols,
    };
  } finally {
    service.dispose();
  }
}

function createFileLanguageService(
  workspace: string,
  filePath: string,
): ts.LanguageService {
  const configPath = findTsConfig(workspace, filePath);
  const parsed = configPath
    ? parseTsConfig(configPath)
    : {
        fileNames: [filePath],
        options: {
          strict: true,
          noEmit: true,
          allowJs: true,
          checkJs: true,
        } satisfies ts.CompilerOptions,
      };
  const rootFileNames = uniqueStrings([...parsed.fileNames, filePath]);
  const versions = new Map<string, string>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => rootFileNames,
    getScriptVersion: (scriptName) => {
      const normalized = path.resolve(scriptName);
      const cached = versions.get(normalized);
      if (cached) return cached;
      const modified = ts.sys.getModifiedTime?.(normalized)?.getTime() ?? 0;
      const version = String(modified);
      versions.set(normalized, version);
      return version;
    },
    getScriptSnapshot: (scriptName) => {
      if (!ts.sys.fileExists(scriptName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(scriptName) ?? "");
    },
    getCurrentDirectory: () => workspace,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function collectNavigationSymbols(
  item: ts.NavigationTree,
  sourceFile: ts.SourceFile,
  relativePath: string,
  symbols: WorkspaceSymbol[],
  limit: number,
  level: number,
): void {
  if (symbols.length >= limit) return;
  const includeCurrent = item.kind !== "script" && item.kind !== "module";
  if (includeCurrent) {
    const span = item.spans[0];
    if (span) {
      const start = sourceFile.getLineAndCharacterOfPosition(span.start);
      const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
      symbols.push({
        path: relativePath,
        name: item.text,
        kind: item.kind,
        kindModifiers: item.kindModifiers,
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        level,
      });
    }
  }
  const childLevel = includeCurrent ? level + 1 : level;
  for (const child of item.childItems ?? []) {
    collectNavigationSymbols(child, sourceFile, relativePath, symbols, limit, childLevel);
    if (symbols.length >= limit) return;
  }
}

function findTsConfig(workspace: string, filePath: string): string | undefined {
  let current = path.dirname(filePath);
  const root = path.resolve(workspace);
  while (isPathInsideOrEqual(root, current)) {
    const candidate = path.join(current, "tsconfig.json");
    if (ts.sys.fileExists(candidate)) return candidate;
    if (isSamePath(current, root)) break;
    current = path.dirname(current);
  }
  const rootCandidate = path.join(root, "tsconfig.json");
  return ts.sys.fileExists(rootCandidate) ? rootCandidate : undefined;
}

function parseTsConfig(configPath: string): {
  fileNames: string[];
  options: ts.CompilerOptions;
} {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatTsDiagnosticMessage(configFile.error));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatTsDiagnosticMessage).join("\n"));
  }
  return {
    fileNames: parsed.fileNames,
    options: parsed.options,
  };
}

function toWorkspaceDiagnostic(
  diagnostic: ts.Diagnostic,
  workspace: string,
  fallbackFilePath: string,
): WorkspaceDiagnostic | undefined {
  const file = diagnostic.file;
  const sourceFilePath = file?.fileName ?? fallbackFilePath;
  const relativePath = workspaceRelativeDiagnosticPath(workspace, sourceFilePath);
  if (!relativePath) return undefined;
  const start = diagnostic.start ?? 0;
  const position = file
    ? file.getLineAndCharacterOfPosition(start)
    : { line: 0, character: 0 };
  return {
    path: relativePath,
    line: position.line + 1,
    column: position.character + 1,
    code: `TS${diagnostic.code}`,
    severity: diagnosticCategoryToSeverity(diagnostic.category),
    message: formatTsDiagnosticMessage(diagnostic),
    source: "language_service",
  };
}

function workspaceRelativeDiagnosticPath(workspace: string, fullPath: string): string | undefined {
  const root = path.resolve(workspace);
  const resolved = path.resolve(fullPath);
  if (!isPathInsideOrEqual(root, resolved)) return undefined;
  return toWorkspaceRelative(root, resolved);
}

function diagnosticCategoryToSeverity(category: ts.DiagnosticCategory): WorkspaceDiagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "message";
  }
}

function formatTsDiagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}
