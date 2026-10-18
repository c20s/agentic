import { resolve, isAbsolute, relative, sep } from "node:path";
import { realpathSync, existsSync } from "node:fs";

/**
 * Sandbox: Allt filsystemsarbete måste ske inom denna root.
 * Skyddar mot path traversal (../../etc/passwd osv) och symlinks
 * som pekar utanför root.
 */
export class Sandbox {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new Error(`Sandbox root måste vara en absolut sökväg, fick: ${root}`);
    }
    if (!existsSync(root)) {
      throw new Error(`Sandbox root finns inte: ${root}`);
    }
    // Normalisera (löser upp symlinks) så vi har en stabil bas att jämföra mot.
    this.root = realpathSync(root);
  }

  /**
   * Slår ihop en relativ (eller absolut) sökväg från klienten med sandbox-roten
   * och verifierar att resultatet fortfarande ligger innanför roten.
   * Kastar fel om sökvägen försöker ta sig ut (t.ex. "../../etc/passwd").
   */
  resolve(userPath: string): string {
    const candidate = isAbsolute(userPath)
      ? resolve(userPath)
      : resolve(this.root, userPath);

    const rel = relative(this.root, candidate);
    const escapesRoot = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

    if (escapesRoot) {
      throw new Error(
        `Otillåten sökväg: "${userPath}" hamnar utanför sandbox-roten (${this.root}).`
      );
    }

    // Om filen/mappen redan finns, lös upp ev. symlinks och verifiera igen,
    // så man inte kan smyga ut via en symlink inuti sandboxen.
    if (existsSync(candidate)) {
      const real = realpathSync(candidate);
      const realRel = relative(this.root, real);
      const realEscapes = realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel);
      if (realEscapes) {
        throw new Error(
          `Otillåten sökväg: "${userPath}" är en symlink som pekar utanför sandbox-roten.`
        );
      }
      return real;
    }

    return candidate;
  }

  /** Sökväg relativt sandbox-roten, för trevlig presentation i svar till agenten. */
  toRelative(absPath: string): string {
    return relative(this.root, absPath) || ".";
  }
}
