import { describe, expect, it } from "vitest";
import { ALL_PROJECTS, destination, projectLabel, workingProject } from "./scope";

const me = (project?: unknown) => ({ homeProject: "home", systemProject: "platform", preferences: project === undefined ? {} : { project } });
const readable = ["home", "lab", "platform"];

describe("the project a person works in", () => {
  it("is their home project until they pick another", () => {
    expect(workingProject(me(), readable)).toBe("home");
    expect(workingProject(me("lab"), readable)).toBe("lab");
  });

  it("can be every project at once", () => {
    expect(workingProject(me(ALL_PROJECTS), readable)).toBe(ALL_PROJECTS);
  });

  it("falls back to home when the pick is gone, is the platform's own, or is not a project", () => {
    expect(workingProject(me("deleted"), readable)).toBe("home");
    expect(workingProject(me("platform"), readable)).toBe("home");
    expect(workingProject(me(42), readable)).toBe("home");
    expect(workingProject(me(""), readable)).toBe("home");
  });

  it("is unknown until the person is", () => {
    expect(workingProject(undefined, readable)).toBeUndefined();
  });
});

describe("how a project is named in the app", () => {
  const names = { home: "alice's home", platform: "Built-in", lab: "lab" };
  const label = (rid: string) => projectLabel(rid, me(), names[rid as keyof typeof names]);

  it("calls the person's own project Personal and the lifted scope All projects", () => {
    expect(label("home")).toBe("Personal");
    expect(label(ALL_PROJECTS)).toBe("All projects");
  });

  it("calls every other project by its name", () => {
    expect(label("lab")).toBe("lab");
    expect(label("platform")).toBe("Built-in");
    expect(projectLabel("unknown", me(), undefined)).toBe("a project");
  });
});

describe("where something new goes", () => {
  it("is the project the person works in", () => {
    expect(destination("lab", undefined)).toEqual({ project: "lab", asking: false });
    expect(destination("home", "lab", "field")).toEqual({ project: "home", asking: false });
  });

  it("is asked for when every project is in view", () => {
    expect(destination(ALL_PROJECTS, undefined)).toEqual({ project: undefined, asking: true });
    expect(destination(ALL_PROJECTS, "lab")).toEqual({ project: "lab", asking: true });
  });

  it("starts from what the page suggests, which the person's own choice replaces", () => {
    expect(destination(ALL_PROJECTS, undefined, "field")).toEqual({ project: "field", asking: true });
    expect(destination(ALL_PROJECTS, "lab", "field")).toEqual({ project: "lab", asking: true });
  });

  it("is nowhere until the person's working project is known", () => {
    expect(destination(undefined, "lab", "field")).toEqual({ project: undefined, asking: false });
  });
});
