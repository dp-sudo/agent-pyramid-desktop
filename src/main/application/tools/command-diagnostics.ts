import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { isPathInsideOrEqual, isSamePath } from "../path-utils.js";
import { shouldSkipEntry, toWorkspaceRelative } from "./workspace-policy.js";
import { assertUtf8TextBuffer } from "./text-file.js";

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

export interface ProjectSymbolSearchResult {
  query?: string;
  path: string;
  fileCount: number;
  symbolCount: number;
  truncated: boolean;
  symbols: WorkspaceSymbol[];
}

export interface ProjectSymbolSearchOptions {
  query?: string;
  caseSensitive: boolean;
  maxSymbols: number;
  maxFiles: number;
}

const PROJECT_SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

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

/**
 * Builds a bounded project-wide symbol map/search on demand. This deliberately
 * reuses a short-lived TypeScript Language Service instead of introducing a
 * long-running index; every candidate file is still filtered through the
 * workspace skip policy and decoded as strict UTF-8 before symbol extraction.
 */
export async function collectProjectSymbols(
  workspace: string,
  rootPath: string,
  options: ProjectSymbolSearchOptions,
): Promise<ProjectSymbolSearchResult> {
  const root = path.resolve(rootPath);
  const configPath = findTsConfig(workspace, root);
  const parsed = configPath
    ? parseTsConfig(configPath)
    : {
        fileNames: collectSourceFiles(root),
        options: defaultCompilerOptions(),
      };
  const candidateFiles = filterProjectSourceFiles(workspace, root, parsed.fileNames);
  const selectedFiles = candidateFiles.slice(0, options.maxFiles);
  await assertUtf8SourceFiles(workspace, selectedFiles, "search_symbols path");

  const service = createLanguageService(workspace, selectedFiles, parsed.options);
  const symbols: WorkspaceSymbol[] = [];
  const query = options.query?.trim();
  const matchesQuery = createSymbolMatcher(query, options.caseSensitive);
  try {
    for (const filePath of selectedFiles) {
      if (symbols.length > options.maxSymbols) break;
      const sourceFile = service.getProgram()?.getSourceFile(filePath) ??
        ts.createSourceFile(
          filePath,
          ts.sys.readFile(filePath) ?? "",
          ts.ScriptTarget.Latest,
          true,
        );
      const relativePath = workspaceRelativeDiagnosticPath(workspace, filePath);
      if (!relativePath) continue;
      const tree = service.getNavigationTree(filePath);
      collectMatchingNavigationSymbols(
        tree,
        sourceFile,
        relativePath,
        symbols,
        options.maxSymbols + 1,
        0,
        matchesQuery,
      );
    }
  } finally {
    service.dispose();
  }

  return {
    ...(query ? { query } : {}),
    path: toWorkspaceRelative(workspace, root) || ".",
    fileCount: selectedFiles.length,
    symbolCount: Math.min(symbols.length, options.maxSymbols),
    truncated: candidateFiles.length > selectedFiles.length || symbols.length > options.maxSymbols,
    symbols: symbols.slice(0, options.maxSymbols),
  };
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
  return createLanguageService(
    workspace,
    uniqueStrings([...parsed.fileNames, filePath]),
    parsed.options,
  );
}

function createLanguageService(
  workspace: string,
  rootFileNames: string[],
  options: ts.CompilerOptions,
): ts.LanguageService {
  const versions = new Map<string, string>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
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

function collectMatchingNavigationSymbols(
  item: ts.NavigationTree,
  sourceFile: ts.SourceFile,
  relativePath: string,
  symbols: WorkspaceSymbol[],
  limit: number,
  level: number,
  matches: (symbol: WorkspaceSymbol) => boolean,
): void {
  if (symbols.length >= limit) return;
  const includeCurrent = item.kind !== "script" && item.kind !== "module";
  if (includeCurrent) {
    const span = item.spans[0];
    if (span) {
      const start = sourceFile.getLineAndCharacterOfPosition(span.start);
      const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
      const symbol: WorkspaceSymbol = {
        path: relativePath,
        name: item.text,
        kind: item.kind,
        kindModifiers: item.kindModifiers,
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        level,
      };
      if (matches(symbol)) {
        symbols.push(symbol);
      }
    }
  }
  const childLevel = includeCurrent ? level + 1 : level;
  for (const child of item.childItems ?? []) {
    collectMatchingNavigationSymbols(
      child,
      sourceFile,
      relativePath,
      symbols,
      limit,
      childLevel,
      matches,
    );
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

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: true,
  };
}

function collectSourceFiles(rootPath: string): string[] {
  if (ts.sys.fileExists(rootPath)) {
    return isProjectSourceFile(rootPath) ? [rootPath] : [];
  }
  if (!ts.sys.directoryExists(rootPath)) return [];
  return ts.sys.readDirectory(
    rootPath,
    [...PROJECT_SOURCE_EXTENSIONS],
    undefined,
    undefined,
  );
}

function filterProjectSourceFiles(
  workspace: string,
  rootPath: string,
  fileNames: readonly string[],
): string[] {
  const workspaceRoot = path.resolve(workspace);
  const root = path.resolve(rootPath);
  return uniqueStrings(fileNames.map((fileName) => path.resolve(fileName)))
    .filter((fileName) =>
      isProjectSourceFile(fileName) &&
      isPathInsideOrEqual(workspaceRoot, fileName) &&
      isPathInsideOrEqual(root, fileName) &&
      !hasSkippedWorkspaceSegment(workspaceRoot, fileName),
    )
    .sort((left, right) =>
      toWorkspaceRelative(workspaceRoot, left).localeCompare(toWorkspaceRelative(workspaceRoot, right)),
    );
}

function isProjectSourceFile(filePath: string): boolean {
  return PROJECT_SOURCE_EXTENSIONS.includes(path.extname(filePath).toLowerCase() as typeof PROJECT_SOURCE_EXTENSIONS[number]);
}

function hasSkippedWorkspaceSegment(workspace: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(workspace), path.resolve(filePath));
  if (!relative) return false;
  return relative.split(path.sep).filter(Boolean).some(shouldSkipEntry);
}

async function assertUtf8SourceFiles(
  workspace: string,
  fileNames: readonly string[],
  label: string,
): Promise<void> {
  for (const fileName of fileNames) {
    const relativePath = toWorkspaceRelative(workspace, fileName);
    assertUtf8TextBuffer(await fs.readFile(fileName), relativePath, label);
  }
}

function createSymbolMatcher(
  query: string | undefined,
  caseSensitive: boolean,
): (symbol: WorkspaceSymbol) => boolean {
  if (!query) return () => true;
  const normalizedQuery = normalizeForSearch(query, caseSensitive);
  return (symbol) => [
    symbol.name,
    symbol.kind,
    symbol.kindModifiers,
    symbol.path,
  ].some((value) => normalizeForSearch(value, caseSensitive).includes(normalizedQuery));
}

function normalizeForSearch(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase();
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
