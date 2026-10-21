import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, findProject, lastProject, listProjects, openProject, projectsHome, projectSummary, registerProject, slugOf } from "../src/projects.js";

const home = () => mkdtempSync(join(tmpdir(), "causeline-home-"));

test("the home is CAUSELINE_HOME when set, else a Causeline folder in the person's home", () => {
  assert.equal(projectsHome({ CAUSELINE_HOME: join(tmpdir(), "x") } as never), join(tmpdir(), "x"));
  assert.match(projectsHome({} as never), /Causeline$/);
});

test("a project gets a folder named from its name, and a name can be used once", () => {
  const h = home();
  const a = createProject(h, "Complaints analysis");
  assert.equal(a.folder, join(h, "complaints-analysis"));
  assert.ok(existsSync(a.folder));
  assert.throws(() => createProject(h, "  complaints ANALYSIS "), /already a project called/);
  const b = createProject(h, "Complaints analysis!");
  assert.notEqual(b.folder, a.folder, "a different name that makes the same folder name gets another folder");
  assert.throws(() => createProject(h, "  "), /needs a name/);
  assert.equal(slugOf("¿¿¿"), "project");
});

test("a project is found by the name the person uses, and an unclear name is not guessed", () => {
  const h = home();
  createProject(h, "Complaints analysis");
  createProject(h, "Contact centre");
  assert.equal(findProject(h, "complaints ANALYSIS").name, "Complaints analysis");
  assert.equal(findProject(h, "contact").name, "Contact centre", "a unique start is enough");
  assert.throws(() => findProject(h, "co"), /could mean/);
  assert.throws(() => findProject(h, "nothing"), /no project called "nothing" \(there are: /);
});

test("opening notes when, the last opened comes back first, and a vanished folder is said", () => {
  const h = home();
  const a = createProject(h, "Alpha");
  const b = createProject(h, "Beta");
  openProject(h, "Alpha");
  assert.equal(lastProject(h)!.name, "Alpha");
  assert.deepEqual(listProjects(h).map((p) => p.name), ["Alpha", "Beta"]);
  rmSync(b.folder, { recursive: true });
  assert.equal(listProjects(h).find((p) => p.name === "Beta")!.missing, true);
  assert.throws(() => openProject(h, "Beta"), /folder for "Beta" is gone/);
  void a;
});

test("an existing folder can be registered, once, under one name", () => {
  const h = home();
  const folder = mkdtempSync(join(tmpdir(), "causeline-pack-"));
  const e = registerProject(h, "Example", folder);
  assert.equal(registerProject(h, "example", folder).folder, e.folder, "the same again changes nothing");
  assert.throws(() => registerProject(h, "Example", mkdtempSync(join(tmpdir(), "other-"))), /another folder/);
  assert.throws(() => registerProject(h, "Ghost", join(h, "nowhere")), /does not exist/);
});

test("the summary of an empty project says what comes next, and never needs a query", () => {
  const h = home();
  const p = createProject(h, "Fresh");
  const s = projectSummary(p.folder, p.name);
  assert.equal(s.name, "Fresh");
  assert.deepEqual([s.kpis, s.experts, s.incidents], [[], [], 0]);
  assert.match(s.next, /Connect/);
});
