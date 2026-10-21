import { resolve, isAbsolute, relative, sep } from "node:path";
import { realpathSync, existsSync } from "node:fs";

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Sandbox: all filesystem access must happen within the main root or one of `extraRoots`.
 * Protects against path traversal (../../etc/passwd etc.) and symlinks
 * that point outside those roots.
 */
export class Sandbox {
  readonly root: string;
  /** Other trusted roots (e.g. where `review_context` checks out PR/branch worktrees) that reads are also allowed under. */
  readonly extraRoots: readonly string[];

  constructor(root: string, extraRoots: string[] = []) {
    if (!isAbsolute(root)) {
      throw new Error(`Sandbox root must be an absolute path, got: ${root}`);
    }
    if (!existsSync(root)) {
      throw new Error(`Sandbox root does not exist: ${root}`);
    }
    // Normalize (resolve symlinks) so we have a stable base to compare against.
    this.root = realpathSync(root);
    this.extraRoots = extraRoots.map((r) => {
      if (!isAbsolute(r)) {
        throw new Error(`Sandbox extra root must be an absolute path, got: ${r}`);
      }
      return existsSync(r) ? realpathSync(r) : resolve(r);
    });
  }

  private allRoots(): readonly string[] {
    return [this.root, ...this.extraRoots];
  }

  /** The configured root (main or extra) that `absPath` falls under, or `undefined` if none. */
  private rootContaining(absPath: string): string | undefined {
    return this.allRoots().find((root) => isWithin(root, absPath));
  }

  /**
   * Joins a relative (or absolute) path from the client with the sandbox root
   * and verifies that the result still lies within the root or one of `extraRoots`.
   * Throws if the path tries to escape (e.g. "../../etc/passwd").
   */
  resolve(userPath: string): string {
    const candidate = isAbsolute(userPath)
      ? resolve(userPath)
      : resolve(this.root, userPath);

    if (!this.rootContaining(candidate)) {
      throw new Error(
        `Disallowed path: "${userPath}" resolves outside the sandbox root (${this.root}).`
      );
    }

    // If the file/directory already exists, resolve any symlinks and verify
    // again, so you can't sneak out via a symlink inside an allowed root.
    if (existsSync(candidate)) {
      const real = realpathSync(candidate);
      if (!this.rootContaining(real)) {
        throw new Error(
          `Disallowed path: "${userPath}" is a symlink pointing outside the sandbox root.`
        );
      }
      return real;
    }

    return candidate;
  }

  /** Path relative to whichever allowed root (main or extra) contains it, for nicer presentation in responses to the agent. */
  toRelative(absPath: string): string {
    const root = this.rootContaining(absPath) ?? this.root;
    return relative(root, absPath) || ".";
  }
}
