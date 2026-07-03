import { describe, it, expect } from "vitest";
import { checkFileHonesty } from "./prod-honesty.js";

const check = (body: string, file = "src/pages/Page.tsx") =>
  checkFileHonesty(`/repo/${file}`, body, "/repo");

describe("prod-honesty check", () => {
  it("A: flags an inline fixture list that is rendered, with no data seam", () => {
    const v = check(`const ITEMS = [{ id: "a" }, { id: "b" }];\nexport function P(){ return <ul>{ITEMS.map(i => <li key={i.id}/>)}</ul>; }`);
    expect(v.map(x => x.cls)).toContain("fixture");
  });

  it("A: does NOT flag when behind a data seam", () => {
    const v = check(`import { dataBackendOn } from "../x";\nconst ITEMS = [{ id: "a" }, { id: "b" }];\nexport function P(){ return <ul>{(dataBackendOn()?[]:ITEMS).map(i => <li key={i.id}/>)}</ul>; }`);
    expect(v.filter(x => x.cls === "fixture")).toHaveLength(0);
  });

  it("A: does NOT flag a config/label map (single object, not a fixture list)", () => {
    const v = check(`const LABEL = { open: "Open", shut: "Shut" };\nexport function P(){ return <span>{LABEL.open}</span>; }`);
    expect(v.filter(x => x.cls === "fixture")).toHaveLength(0);
  });

  it("A: honors @slowcook-honest on the decl line", () => {
    const v = check(`const ROWS = [{ a: 1 }, { a: 2 }]; // @slowcook-honest price config\nexport function P(){ return <>{ROWS.map(r => r.a)}</>; }`);
    expect(v.filter(x => x.cls === "fixture")).toHaveLength(0);
  });

  it("B: flags a router with many routes and no guard", () => {
    const routes = Array.from({ length: 5 }, (_, i) => `<Route path="/p${i}" element={<X/>} />`).join("\n");
    const v = check(`export function App(){ return <Routes>${routes}</Routes>; }`, "src/App.tsx");
    expect(v.map(x => x.cls)).toContain("gating");
  });

  it("B: clean when a guard is referenced", () => {
    const routes = Array.from({ length: 5 }, (_, i) => `<Route path="/p${i}" element={<X/>} />`).join("\n");
    const v = check(`import { RequireAuth } from "./g";\nexport function App(){ return <Routes><Route element={<RequireAuth/>}>${routes}</Route></Routes>; }`, "src/App.tsx");
    expect(v.filter(x => x.cls === "gating")).toHaveLength(0);
  });

  it("C: flags an onClick that only setState-s", () => {
    const v = check(`export function P(){ return <button onClick={() => setSubmitted(true)}>Go</button>; }`);
    expect(v.map(x => x.cls)).toContain("dead_cta");
  });

  it("C: clean when the onClick has a real effect", () => {
    const v = check(`export function P(){ return <button onClick={() => void save()}>Go</button>; }`);
    expect(v.filter(x => x.cls === "dead_cta")).toHaveLength(0);
  });

  it("C: does NOT flag legitimate local view-state (modal/tab)", () => {
    const v = check(`export function P(){ return <button onClick={() => setOpen(true)}>Open</button>; }`);
    expect(v.filter(x => x.cls === "dead_cta")).toHaveLength(0);
  });

  it("C: does NOT flag a reset (setSent(false)) — that's view-state, not fake success", () => {
    const v = check(`export function P(){ return <button onClick={() => { setSent(false); setCode(""); }}>Back</button>; }`);
    expect(v.filter(x => x.cls === "dead_cta")).toHaveLength(0);
  });

  it("C: FLAGS a fake-success even when a CONDITIONAL disabled is on the line", () => {
    const v = check(`export function P(){ return <button onClick={() => setDone(true)} disabled={!ok || done}>Satisfy</button>; }`);
    expect(v.map(x => x.cls)).toContain("dead_cta");
  });

  it("C: honors @slowcook-honest on the line ABOVE the handler", () => {
    const v = check(`export function P(){ return (\n  <button\n    // @slowcook-honest: demo only\n    onClick={() => setDone(true)}\n  >Go</button>\n); }`);
    expect(v.filter(x => x.cls === "dead_cta")).toHaveLength(0);
  });

  it("C: clean with a BARE disabled (always-off honest state)", () => {
    const v = check(`export function P(){ return <button onClick={() => setDone(true)} disabled>Coming</button>; }`);
    expect(v.filter(x => x.cls === "dead_cta")).toHaveLength(0);
  });

  it("C: clean when the theater is acknowledged deferred", () => {
    const v = check(`export function P(){ return <button onClick={() => setSubmitted(true)} disabled>Coming soon</button>; }`);
    expect(v.filter(x => x.cls === "dead_cta")).toHaveLength(0);
  });

  it("ignores test files by extension via the walker (unit: decl still parses)", () => {
    // checkFileHonesty itself doesn't filter; the walker does. Sanity: a fixture in a normal file flags.
    expect(check(`const A=[{x:1},{x:2}];\nexport const P=()=>A.map(a=>a.x);`).length).toBeGreaterThan(0);
  });
});
