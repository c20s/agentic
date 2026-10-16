const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function commentableLinesByFile(unifiedDiff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLine = 0;

  for (const rawLine of unifiedDiff.split("\n")) {
    const fileHeader = rawLine.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      currentFile = fileHeader[1];
      if (!result.has(currentFile)) {
        result.set(currentFile, new Set());
      }
      continue;
    }

    const hunk = rawLine.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      result.get(currentFile)!.add(newLine);
      newLine += 1;
    } else if (rawLine.startsWith(" ")) {
      result.get(currentFile)!.add(newLine);
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      // deleted line, no new-side line number to advance
    }
  }

  return result;
}

export function isLineCommentable(commentable: Map<string, Set<number>>, file: string, line: number): boolean {
  return commentable.get(file)?.has(line) ?? false;
}
