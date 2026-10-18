import { resolve, isAbsolute, relative, sep } from "node:path";
import { realpathSync, existsSync } from "node:fs";

/**
 * Sandbox: all filesystem access must happen within this root.
 * Protects against path traversal (../../etc/passwd etc.) and symlinks
 * that point outside the root.
 */
export class Sandbox {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new Error(`Sandbox root must be an absolute path, got: ${root}`);
    }
    if (!existsSync(root)) {
      throw new Error(`Sandbox root does not exist: ${root}`);
    }
    // Normalize (resolve symlinks) so we have a stable base to compare against.
    this.root = realpathSync(root);
  }

  /**
   * Joins a relative (or absolute) path from the client with the sandbox root
   * and verifies that the result still lies within the root.
   * Throws if the path tries to escape (e.g. "../../etc/passwd").
   */
  resolve(userPath: string): string {
    const candidate = isAbsolute(userPath)
      ? resolve(userPath)
      : resolve(this.root, userPath);

    const rel = relative(this.root, candidate);
    const escapesRoot = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

    if (escapesRoot) {
      throw new Error(
        `Disallowed path: "${userPath}" resolves outside the sandbox root (${this.root}).`
      );
    }

    // If the file/directory already exists, resolve any symlinks and verify
    // again, so you can't sneak out via a symlink inside the sandbox.
    if (existsSync(candidate)) {
      const real = realpathSync(candidate);
      const realRel = relative(this.root, real);
      const realEscapes = realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel);
      if (realEscapes) {
        throw new Error(
          `Disallowed path: "${userPath}" is a symlink pointing outside the sandbox root.`
        );
      }
      return real;
    }

    return candidate;
  }

  /** Path relative to the sandbox root, for nicer presentation in responses to the agent. */
  toRelative(absPath: string): string {
    return relative(this.root, absPath) || ".";
  }
}
