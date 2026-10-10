import { loadTemplates, MAX_TEMPLATES, useTemplateStore } from "./canvasTemplates";

beforeEach(() => {
  localStorage.clear();
  useTemplateStore.setState({ templates: [] });
});

describe("saved canvas templates", () => {
  it("persists to local storage and survives a reload", () => {
    expect(
      useTemplateStore.getState().save("Podcast clip", { width: 1080, height: 1080, fps: 30 }),
    ).toBeNull();
    const reloaded = loadTemplates();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ name: "Podcast clip", width: 1080, height: 1080, fps: 30 });
  });

  it("replaces a template with the same name instead of duplicating it", () => {
    const s = useTemplateStore.getState();
    s.save("Mine", { width: 1080, height: 1080, fps: 30 });
    useTemplateStore.getState().save("mine", { width: 1280, height: 720, fps: 25 });
    expect(useTemplateStore.getState().templates).toHaveLength(1);
    expect(useTemplateStore.getState().templates[0]).toMatchObject({ width: 1280, fps: 25 });
  });

  it("validates before saving and explains why it refuses", () => {
    const s = useTemplateStore.getState();
    expect(s.save("   ", { width: 1080, height: 1080, fps: 30 })).toMatch(/name/);
    expect(s.save("Odd", { width: 1081, height: 1080, fps: 30 })).toMatch(/even/);
    expect(s.save("Slow", { width: 1080, height: 1080, fps: 0 })).toMatch(/Frame rate/);
    expect(useTemplateStore.getState().templates).toHaveLength(0);
  });

  it("ignores corrupted storage and drops invalid entries", () => {
    localStorage.setItem("cutvii.canvasTemplates.v1", "{not json");
    expect(loadTemplates()).toEqual([]);
    localStorage.setItem(
      "cutvii.canvasTemplates.v1",
      JSON.stringify([
        { id: "a", name: "ok", width: 1080, height: 1920, fps: 30 },
        { id: "b", name: "bad", width: 1081, height: 1920, fps: 30 },
        "junk",
      ]),
    );
    expect(loadTemplates().map((t) => t.id)).toEqual(["a"]);
  });

  it("caps the list and supports deleting", () => {
    for (let i = 0; i < MAX_TEMPLATES; i++) {
      useTemplateStore.getState().save(`t${i}`, { width: 1080, height: 1080, fps: 30 });
    }
    expect(useTemplateStore.getState().save("one too many", { width: 1080, height: 1080, fps: 30 })).toMatch(
      /up to/,
    );
    const first = useTemplateStore.getState().templates[0];
    useTemplateStore.getState().remove(first.id);
    expect(useTemplateStore.getState().templates).toHaveLength(MAX_TEMPLATES - 1);
    expect(loadTemplates()).toHaveLength(MAX_TEMPLATES - 1);
  });
});
