export interface CStylePathDecodeOptions {
  danglingBackslash?: "literal" | "throw";
  invalidMessage?: string;
}

/**
 * Git surfaces quoted path bytes with C-style escapes and octal UTF-8 bytes.
 * Keep that decoding centralized so permission subjects and structured Git
 * status paths cannot drift apart.
 */
export function decodeCStyleEscapedPath(
  value: string,
  options: CStylePathDecodeOptions = {},
): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      appendUtf8(bytes, char);
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      if (options.danglingBackslash === "throw") {
        throw new Error(options.invalidMessage ?? "C-style path escape is invalid.");
      }
      appendUtf8(bytes, char);
      continue;
    }
    if (isOctalDigit(escaped)) {
      let octal = escaped;
      let consumed = 1;
      while (
        consumed < 3 &&
        index + 1 + consumed < value.length &&
        isOctalDigit(value[index + 1 + consumed])
      ) {
        octal += value[index + 1 + consumed];
        consumed += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      index += consumed;
      continue;
    }
    appendUtf8(bytes, decodeCStyleEscape(escaped));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function appendUtf8(bytes: number[], value: string): void {
  bytes.push(...Buffer.from(value, "utf8"));
}

function isOctalDigit(value: string): boolean {
  return value >= "0" && value <= "7";
}

function decodeCStyleEscape(value: string): string {
  switch (value) {
    case "a":
      return "\x07";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "v":
      return "\v";
    case "\"":
      return "\"";
    case "\\":
      return "\\";
    default:
      return value;
  }
}
