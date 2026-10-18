# local-mcp-server

En lokal [MCP](https://modelcontextprotocol.io)-server (TypeScript, körs med Bun) som
ger en agent **enbart** en väg in till din dator: via det här verktyget.

Tanken: en session ska kunna startas med *endast* denna MCP registrerad, så att
all context (läsning av filer, listning av mappar, sökning) och alla ändringar
(skrivning av filer) går via samma, granskbara yta — inget annat filsystemsverktyg
behövs eller exponeras.

## Verktyg

Read-only (context):

- `list_dir` – lista filer/mappar
- `read_file` – läs en fils innehåll (se "Outline-läge" nedan — default är en
  förkortad outline, inte hela filen)
- `file_stat` – metadata (storlek, typ, senast ändrad)
- `search_files` – sök text/regex i filINNEHÅLL, implementerad med [ripgrep](https://github.com/BurntSushi/ripgrep)
  (`rg` måste finnas på `PATH`, t.ex. `brew install ripgrep`). Stödjer:
  - `query` – text (default) eller regex om `regex: true`
  - `filePattern` – glob-filter, t.ex. `*.ts`
  - `caseSensitive` – default `false`
  - Hoppar automatiskt över `node_modules`, `.git`, `dist`, m.fl.
- `find_files` – hitta filer baserat på FILNAMN/sökväg (inte innehåll), också
  via ripgrep (`rg --files --glob`). Komplement till `search_files`
  (innehåll) och `list_dir` (kräver att man redan är i rätt mapp):
  - `pattern` – glob (`*.ts`, `src/**/*.test.ts`) eller en enkel substring
    som `"invite"` (tolkas automatiskt som `*invite*`)
  - `path` – mapp att söka inom, default sandbox-roten
  - `caseSensitive` – default `false`
  - Exempel: `find_files({ pattern: "invite-member-command" })` hittar filen
    oavsett var i trädet den ligger, utan att du behöver gissa mappstruktur
    eller gå via en innehålls-sökning.

### Outline-läge för `read_file`

Per default returnerar `read_file` **inte** hela filinnehållet för vissa
filtyper — istället en kompakt outline, för att spara context:

| Filtyp | Default-output |
|---|---|
| `.md` / `.mdx` | Alla rubriker/underrubriker med radnummer och indrag efter nivå |
| `.ts` / `.tsx` / `.js` / `.jsx` | Alla top-level `import`/`const`/`function`/`interface`/`type`/`class`/`enum`, med signatur men **utan body** (riktig TS-AST-parsning, inte regex) |
| `.json` / `.jsonc` | Alla nyckel-paths rekursivt, t.ex. `foo`, `foo.bar`, `foo.bar.baz`, `items[0].name` |
| `.yaml` / `.yml` | Samma som JSON ovan — alla nyckel-paths rekursivt (parsas med `Bun.YAML`, inbyggt i Bun) |
| Övriga filtyper | Hela filen, som vanligt |

**Täckningsgaranti för TS/JS-outline:** om en fil innehåller top-level-kod som
inte är en känd deklarationstyp (t.ex. ett löst `console.log(...)`, en IIFE,
eller annan "lös" kod direkt i filen), markeras den som `other` i outline
**och** en explicit varning läggs till i svaret: outline är då INTE en
fullständig representation av filen. Filer utan sådan lös kod får ingen
varning — outline-listan (inkl. imports) täcker då verkligen allt på
top-level i filen.

Två sätt att få mer:

- **`symbol: "<namn/path/rubrik>"`** – hämta bara en specifik del:
  - `.md`: matchar rubriktext (substring, case-insensitive) → hela den
    sektionen (till nästa rubrik på samma eller högre nivå)
  - `.ts`/`.js` m.fl.: matchar ett symbolnamn → hela källkoden **inklusive
    body**
  - `.json`/`.yaml`/`.yml`: en nyckel-path (t.ex. `"foo.bar.baz"` eller
    `"items[0].name"`) → värdet på den pathen
- **`full: true`** – hoppa över outline-logiken helt, hämta hela filen rakt av
  (oavsett filtyp).

Exempel-flöde för en agent: läs `src/tools.ts` utan argument → ser en lista
med alla top-level-symboler → läser sen `read_file({ path: "src/tools.ts",
symbol: "writeFileTool" })` för att få just den funktionens/konstantens
fullständiga källkod.

Write (de enda vägarna att ändra något):

- `edit_file` – **föredraget** sätt att ändra en befintlig fil: riktad
  sök-och-ersätt (`oldString` → `newString`) utan att behöva känna till eller
  skicka med hela filens innehåll. `oldString` måste matcha exakt en gång
  (säkerhetsspärr mot tvetydiga ändringar), om inte `replaceAll: true` anges.
- `write_file` – skriv/skapa en fil med **fullständigt** nytt innehåll (hela
  filen skrivs över). Använd för att skapa nya filer, eller när du medvetet
  vill ersätta en hel fil och faktiskt har läst den i sin helhet (`full:
  true`) först.

Det finns **inget** verktyg för att ta bort filer, köra skal-kommandon, flytta
filer, osv. Om du vill utöka servern med fler skrivoperationer, lägg till dem
explicit i `src/tools.ts` och tänk igenom konsekvenserna — håll gärna skriv-ytan
så smal som möjligt.

### Varför både `edit_file` och `write_file`?

Outline-läget (ovan) är utmärkt för att **läsa/förstå** kod effektivt, men det
är en partiell vy av filen. Eftersom `write_file` skriver över HELA filen,
skulle en skrivning baserad enbart på en partiell läsning riskera att tappa
bort kod agenten aldrig såg (imports den inteläste, kommentarer, lös kod,
exakt formatering, etc.).

`edit_file` löser detta: det kräver bara den exakta biten som ska ändras
(`oldString`/`newString`), aldrig hela filen. Det gör att agenten kan göra
helt riktade ändringar — lägga till en import, ändra en funktions body, lägga
till en ny export — utan att någonsin behöva läsa eller skriva om resten av
filen den inte brydde sig om.

Rekommenderat flöde för agenten:
1. `read_file` (outline eller `symbol`) för att hitta och förstå rätt ställe
2. `edit_file` för att göra den riktade ändringen
3. `write_file` bara när en helt ny fil ska skapas, eller när hela filen
   medvetet ska ersättas (efter `full: true`-läsning)

## Sandbox

Allt är begränsat till en **root-katalog**. Sökvägar som försöker ta sig ut
(`../../etc/passwd`, symlinks som pekar utanför roten, etc.) avvisas med fel.
Se `src/sandbox.ts`.

Root bestäms i prioritetsordning:

1. Första CLI-argumentet: `bun run src/index.ts /path/till/projekt`
2. Env-variabeln `MCP_SANDBOX_ROOT`
3. Annars: den katalog servern startas ifrån (`cwd`)

## Köra lokalt

```bash
bun install
bun run start /path/till/mitt/projekt
```

Servern pratar MCP över stdio (standard för lokala MCP-servrar) och loggar
status till stderr, så den stör inte JSON-RPC-trafiken på stdout.

## Monitorera vad agenten faktiskt gör

När Claude Code (t.ex. via `ai`-aliaset) startar en session spawnar den
MCP-servern själv som en bakgrundsprocess — den syns inte i en egen terminal,
och du kan **inte** ansluta en egen klient till en redan körande instans
(stdio-transport är en 1-till-1-koppling mellan den process som startade
servern och servern själv).

Istället loggar servern varje verktygsanrop (namn, argument, resultat/fel,
tidsåtgång) till en loggfil. Kör i ett separat terminalfönster:

```bash
tail -f ~/.claude/mcp-local-fs.log
```

så ser du i realtid vad agenten gör — t.ex:

```
[2026-10-18T15:59:35.995Z] [call] list_dir {"path":".","recursive":false}
[2026-10-18T15:59:35.998Z] [ok]   list_dir (2ms) -> .apm/
.gitignore
...
[2026-10-18T15:59:36.010Z] [call] read_file {"path":"README.md"}
[2026-10-18T15:59:36.011Z] [ok]   read_file (1ms) -> # agentic
...
```

Loggfilens path kan ändras med env-variabeln `MCP_LOG_FILE`. Sätt den till en
tom sträng (`MCP_LOG_FILE=""`) för att stänga av filloggning helt (du får då
bara stderr-loggning, vilket bara syns om du kör servern manuellt i en
terminal).

Om du vill köra servern helt fristående (t.ex. för att testa den isolerat
eller peka en MCP-inspector mot den) går det förstås också:

```bash
bun run start /path/till/mappen
```

men kom ihåg: då kan inte Claude Code ansluta till *den* instansen samtidigt
— Claude Code startar alltid sin egen process enligt `--mcp-config`.

## Koppla in i Claude Code / Claude Desktop

Lägg till i din MCP-konfiguration (t.ex. `~/.claude.json` eller motsvarande
`mcpServers`-sektion):

```json
{
  "mcpServers": {
    "local-fs": {
      "command": "bun",
      "args": [
        "run",
        "/Users/erihan/dev/c20s/agentic/apps/local-mcp-server/src/index.ts",
        "/Users/erihan/dev/mitt-projekt"
      ]
    }
  }
}
```

Byt sista argumentet mot den mapp du vill att agenten ska få tillgång till i
just den sessionen. Starta en ny session per projekt/root om du vill hålla
sandboxarna strikt åtskilda.

Om du startar en session med **enbart** denna MCP aktiverad (dvs. inga andra
verktyg för filsystem/skal tillåtna i den klienten) så är detta den enda vägen
in/ut för agenten till din disk, precis som tänkt.

### Strikt, låst session via `claude`-CLI:n

För att verkligen tvinga fram "bara denna MCP, inget annat" räcker det **inte**
med `--bare` + `--strict-mcp-config` ensamt — de styr bara vilka *MCP-servrar*
som laddas. Claude Code har fortfarande sina inbyggda verktyg (`Bash`, `Edit`,
`Read`, `Write`, `Glob`, `Grep`, m.fl.) kvar som standard. De måste blockeras
explicit med `--disallowedTools`.

1. Skapa **en enda, global** MCP-configfil, t.ex. `~/.claude/mcp-local-fs.json`
   — **utan** `cwd`-fält:

   ```json
   {
     "mcpServers": {
       "local-fs": {
         "command": "bun",
         "args": [
           "run",
           "/Users/erihan/dev/c20s/agentic/apps/local-mcp-server/src/index.ts"
         ]
       }
     }
   }
   ```

   (Mallen finns även som `mcp.config.example.json` i detta repo.)

   Ingen `cwd` behövs eftersom servern faller tillbaka på `process.cwd()` —
   och Claude Code startar MCP-servern med samma arbetskatalog som `claude`
   själv kördes ifrån. Det betyder att **samma globala config funkar för alla
   projekt**: sandbox-roten blir automatiskt vilken mapp du än står i när du
   kör kommandot (verifierat: körning från mapp A resp. mapp B med identisk
   config gav isolerad åtkomst till respektive mapp, och `../`-försök att
   läsa ut ur sandboxen blockerades).

   Prioritetsordningen för sandbox-root i servern är fortfarande: CLI-arg →
   `MCP_SANDBOX_ROOT` env → `cwd` den startades med — så du kan fortfarande
   override:a per projekt om du nån gång skulle vilja det, men det behövs
   inte för normalfallet.

2. Kör med följande kombination (verifierad att fungera):

   ```bash
   claude --bare \
     --settings ~/.claude/settings.json \
     --setting-sources project \
     --mcp-config ~/.claude/mcp-local-fs.json \
     --strict-mcp-config \
     --disable-slash-commands \
     --disallowedTools "Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit"
   ```

   Vad varje flagga gör här:

   - `--bare` – minimalt läge, hoppar bl.a. över auto-discovery av
     `.mcp.json`/CLAUDE.md (men respekterar `--mcp-config`/`--settings`
     eftersom de anges explicit).
   - `--settings ~/.claude/settings.json` – dina vanliga inställningar
     (auth via `apiKeyHelper`, permissions, etc.) eftersom `--bare` aldrig
     läser OAuth/keychain.
   - `--setting-sources project` – läs bara projektets `settings.json`
     utöver `--settings`-filen, inte user/local.
   - `--mcp-config ~/.claude/mcp-local-fs.json` – **måste** anges explicit;
     utan den tillåter `--strict-mcp-config` noll MCP-servrar alls.
   - `--strict-mcp-config` – ignorera alla andra MCP-källor, använd bara
     det som står i `--mcp-config`.
   - `--disable-slash-commands` – inga slash-kommandon.
   - `--disallowedTools "Bash,Edit,Read,Write,..."` – **det här är kritiskt**:
     blockerar Claude Codes inbyggda filsystems-/skalverktyg så att
     `mcp__local-fs__*` blir den enda återstående vägen till disk.

   Praktiskt: lägg hela kommandot i ett shell-alias, t.ex. i `~/.zshrc`:

   ```bash
   alias ai='claude --bare --settings ~/.claude/settings.json --setting-sources project --mcp-config ~/.claude/mcp-local-fs.json --strict-mcp-config --disable-slash-commands --disallowedTools "Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit"'
   ```

   Kör sen bara `ai` från vilket projekts rot-mapp du vill ge agenten
   tillgång till — ingen projekt-specifik konfiguration behövs.

3. Verifiera i en session att det blev rätt:

   ```bash
   ai -p "Vilka verktyg har du tillgång till? Lista dem alla."
   ```

   Förväntat svar: enbart `mcp__local-fs__list_dir`, `read_file`, `file_stat`,
   `search_files`, `find_files`, `edit_file` och `write_file`.

   **Viktigt att komma ihåg:** en vanlig, oinskränkt `claude`-session (utan
   `--bare`/`--disallowedTools`) har fortfarande fulla `Bash`/`Edit`/`Read`/
   `Write`-verktyg precis som vanligt — det är bara `ai`-aliaset (eller
   motsvarande explicita flaggor) som ger den låsta, MCP-only-upplevelsen.
   Om du ser t.ex. `git ls-files` köras via `Bash` i en session, betyder det
   att den sessionen startades utan dessa flaggor, inte att låsningen läckte.

## Begränsningar / medvetna val

- Max filstorlek för `read_file`: 1 MB (skydd mot att råka svälja
  jättefiler/binärer in i context).
- `list_dir`/`search_files` ignorerar brus som `node_modules`, `.git`, `dist`
  m.fl.
- `write_file` skriver över hela filen (ingen patch/diff-logik) — enklast att
  resonera om och granska.
- Inga destruktiva verktyg (delete, move, exec) finns med avsikt.
- `search_files` kräver `ripgrep` (`rg`) installerat på systemet och i
  `PATH`. Servern kör `rg` som subprocess (`Bun.spawn`) med `--json` för
  robust parsning av resultat. Sökvägen (`path`-argumentet) valideras och
  låses till sandboxen *innan* `rg` anropas, så traversal-försök via det
  argumentet stoppas av vårt eget sandbox-lager, inte av ripgrep.
