import { describe, it, expect } from "bun:test";
import { LIST_TEMPLATE, STATUS_TEMPLATE } from "../../src/sync/mutagen";

// Mutagen 0.17.6's session model (pkg/api/models/synchronization) embeds two structs by pointer
// and leaves them nil: SessionState while the session is paused, and an endpoint's EndpointState
// while that endpoint is disconnected. Go's template engine fails the whole `sync list` on a field
// reached through either ("reflect: indirection through nil pointer to embedded struct field
// SessionState", reproduced with text/template), so one paused session or one stopped workspace
// made `haven status` report every directory as disconnected. Mutagen runs these templates, not
// this test, so it reads them: every such field must sit under an `if` or `with` on its struct.
const SESSION_STATE = ["LastError", "SuccessfulCycles", "Conflicts", "ExcludedConflicts"];
const ENDPOINT_STATE = [
  "Scanned", "Directories", "Files", "SymbolicLinks", "TotalFileSize", "ScanProblems",
  "ExcludedScanProblems", "TransitionProblems", "ExcludedTransitionProblems", "StagingProgress",
];

// The fields a template reads from those structs outside a block that checks the struct first.
function unguardedFields(template: string): string[] {
  // The condition of each open block; "" where none holds (a range, or the else of an if).
  const guards: string[] = [];
  const unguarded: string[] = [];
  const check = (expression: string) => {
    for (const [field] of expression.matchAll(/(?:\.[A-Z]\w*)+/g)) {
      const parts = field.slice(1).split(".");
      const owner = parts.length === 1 && SESSION_STATE.includes(parts[0]!)
        ? ".SessionState"
        : parts.length === 2 && ENDPOINT_STATE.includes(parts[1]!) ? `.${parts[0]}.EndpointState` : null;
      if (owner !== null && !guards.includes(owner)) unguarded.push(field);
    }
  };
  for (const [, action = ""] of template.matchAll(/{{-?\s*([\s\S]*?)\s*-?}}/g)) {
    const [keyword = "", ...rest] = action.split(/\s+/);
    const expression = rest.join(" ");
    if (keyword === "end") guards.pop();
    else if (keyword === "else") guards[guards.length - 1] = "";
    else if (keyword === "if" || keyword === "with") {
      check(expression);
      guards.push(expression);
    } else if (keyword === "range") {
      check(expression);
      guards.push("");
    } else check(action);
  }
  return unguarded;
}

describe("sync list templates", () => {
  it("read a paused session's and a disconnected endpoint's fields only behind a check", () => {
    expect(unguardedFields(STATUS_TEMPLATE)).toEqual([]);
    expect(unguardedFields(LIST_TEMPLATE)).toEqual([]);
  });

  it("would have caught the template that broke haven status", () => {
    const before = "{{range .}}{{.Name}}|{{.Status.Description}}|{{len .Conflicts}}|{{range .Alpha.ScanProblems}}{{.}};;{{end}}|{{range .Beta.ScanProblems}}{{.}};;{{end}}\n{{end}}";
    expect(unguardedFields(before)).toEqual([".Conflicts", ".Alpha.ScanProblems", ".Beta.ScanProblems"]);
    expect(unguardedFields("{{range .}}{{if .SessionState}}x{{else}}{{len .Conflicts}}{{end}}{{end}}")).toEqual([".Conflicts"]);
  });
});
