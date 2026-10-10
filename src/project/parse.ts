import { ProjectSchema, type Project } from "./model";

export type ParseResult = { ok: true; project: Project } | { ok: false; errors: string[] };

/** Validate untrusted data (e.g. a project file) and return readable errors instead of throwing. */
export function parseProject(input: unknown): ParseResult {
  const result = ProjectSchema.safeParse(input);
  if (result.success) return { ok: true, project: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
  };
}
