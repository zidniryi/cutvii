import { z } from "zod";

/** Bump when the on-disk shape changes, and add a migration in `src-tauri/src/project/migrate.rs`. v2: clip speed. v3: fitMode. v4: fitBackground. */
export const SCHEMA_VERSION = 4;

/** Tolerance (seconds) when comparing a clip's sourceOut with the asset duration. */
const DURATION_EPSILON = 1e-3;
const MAX_VOLUME = 2;

const Id = z.string().min(1);

export const SPEED_LIMITS = { min: 0.1, max: 10 } as const;

export const MediaTypeSchema = z.enum(["video", "audio", "image"]);

/** Canvas limits. The same numbers are enforced in Rust (`project/validation.rs`). */
export const CANVAS_LIMITS = { minSide: 16, maxSide: 8192, minFps: 1, maxFps: 120 } as const;

const sideSchema = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(
      CANVAS_LIMITS.minSide,
      `${label} must be between ${CANVAS_LIMITS.minSide} and ${CANVAS_LIMITS.maxSide} px`,
    )
    .max(
      CANVAS_LIMITS.maxSide,
      `${label} must be between ${CANVAS_LIMITS.minSide} and ${CANVAS_LIMITS.maxSide} px`,
    )
    .refine((n) => n % 2 === 0, `${label} must be an even number`);

export const WidthSchema = sideSchema("Width");
export const HeightSchema = sideSchema("Height");
export const FpsSchema = z
  .number({ error: "Frame rate must be a number" })
  .min(CANVAS_LIMITS.minFps, `Frame rate must be between ${CANVAS_LIMITS.minFps} and ${CANVAS_LIMITS.maxFps}`)
  .max(
    CANVAS_LIMITS.maxFps,
    `Frame rate must be between ${CANVAS_LIMITS.minFps} and ${CANVAS_LIMITS.maxFps}`,
  );

export const CanvasSchema = z.object({ width: WidthSchema, height: HeightSchema, fps: FpsSchema });

/** Exact frame rate as a fraction. Both parts or neither. */
const rationalParts = {
  fpsNum: z.number().int().positive().optional(),
  fpsDen: z.number().int().positive().optional(),
};

export const ProjectSettingsSchema = z
  .object({
    width: WidthSchema,
    height: HeightSchema,
    fps: FpsSchema,
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #RRGGBB color"),
    ...rationalParts,
    /** "Original" canvas chosen, no media yet: the first media added decides the canvas. */
    canvasPending: z.boolean().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.fpsNum === undefined) !== (s.fpsDen === undefined)) {
      ctx.addIssue({ code: "custom", path: ["fpsNum"], message: "fpsNum and fpsDen must be given together" });
    } else if (
      s.fpsNum !== undefined &&
      s.fpsDen !== undefined &&
      Math.abs(s.fpsNum / s.fpsDen - s.fps) > 1e-6
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fps"],
        message: `fps ${s.fps} does not match the exact rate ${s.fpsNum}/${s.fpsDen}`,
      });
    }
  });

export const MediaAssetSchema = z
  .object({
    id: Id,
    path: z.string().min(1),
    type: MediaTypeSchema,
    duration: z.number().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    thumbnailPath: z.string().min(1).optional(),
    ...rationalParts,
  })
  .strict()
  .refine((a) => (a.fpsNum === undefined) === (a.fpsDen === undefined), {
    message: "fpsNum and fpsDen must be given together",
    path: ["fpsNum"],
  });

/** What shows behind a picture where it does not cover the canvas, plus the blur strength of "blur-bg". */
export const FitBackgroundSchema = z
  .object({
    kind: z.enum(["black", "color", "image"]),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "must be a #RRGGBB color")
      .optional(),
    /** An image asset of the project (it is scaled to cover the canvas). */
    assetId: z.string().min(1).optional(),
    /** Blur amount 0-100 for "blur-bg"; absent means 30 (a radius of 3 % of the canvas height). */
    blur: z.number().min(0).max(100).optional(),
  })
  .strict()
  .refine((b) => b.kind !== "color" || b.color !== undefined, {
    message: "a colour background needs a colour",
    path: ["color"],
  })
  .refine((b) => b.kind !== "image" || b.assetId !== undefined, {
    message: "an image background needs an image",
    path: ["assetId"],
  });

export const TimelineClipSchema = z
  .object({
    id: Id,
    assetId: Id,
    trackId: Id,
    timelineStart: z.number().nonnegative(),
    sourceIn: z.number().nonnegative(),
    sourceOut: z.number().nonnegative(),
    volume: z.number().min(0).max(MAX_VOLUME),
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().positive().finite(),
    opacity: z.number().min(0).max(1),
    /** How a video or image is scaled to the canvas; absent means "fill". Never shown at native pixel size. */
    fitMode: z.enum(["fill", "fit", "blur-bg"]).optional(),
    /** Background behind the picture; absent means black. */
    fitBackground: FitBackgroundSchema.optional(),
    /** Playback speed, 0.1 to 10; absent means 1. Timeline length = (sourceOut - sourceIn) / speed. */
    speed: z
      .number()
      .min(SPEED_LIMITS.min, "Speed must be between 0.1× and 10×")
      .max(SPEED_LIMITS.max, "Speed must be between 0.1× and 10×")
      .optional(),
    /** Keep the original pitch when the speed changes; absent means true. */
    keepPitch: z.boolean().optional(),
    /** Play the used source range backwards; absent means false. */
    reversed: z.boolean().optional(),
  })
  .strict()
  .refine((c) => c.sourceOut > c.sourceIn, {
    message: "sourceOut must be greater than sourceIn",
    path: ["sourceOut"],
  });

export const TimelineTrackSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    type: z.enum(["video", "audio"]),
    order: z.number().int().nonnegative(),
    muted: z.boolean(),
    hidden: z.boolean(),
    clips: z.array(TimelineClipSchema),
  })
  .strict();

export const ProjectSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    schemaVersion: z.literal(SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
    modifiedAt: z.iso.datetime(),
    settings: ProjectSettingsSchema,
    assets: z.array(MediaAssetSchema),
    tracks: z.array(TimelineTrackSchema),
  })
  .strict()
  .superRefine((project, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    const assets = new Map<string, z.infer<typeof MediaAssetSchema>>();
    project.assets.forEach((a, i) => {
      if (assets.has(a.id)) fail(["assets", i, "id"], `duplicate asset id "${a.id}"`);
      assets.set(a.id, a);
    });

    const trackIds = new Set<string>();
    const clipIds = new Set<string>();
    project.tracks.forEach((track, ti) => {
      if (trackIds.has(track.id)) fail(["tracks", ti, "id"], `duplicate track id "${track.id}"`);
      trackIds.add(track.id);

      track.clips.forEach((clip, ci) => {
        const at = ["tracks", ti, "clips", ci];
        if (clipIds.has(clip.id)) fail([...at, "id"], `duplicate clip id "${clip.id}"`);
        clipIds.add(clip.id);
        if (clip.trackId !== track.id)
          fail([...at, "trackId"], `clip.trackId "${clip.trackId}" does not match its track`);

        if (clip.fitBackground?.kind === "image") {
          const image = assets.get(clip.fitBackground.assetId ?? "");
          if (!image) fail([...at, "fitBackground", "assetId"], "unknown image asset");
          else if (image.type !== "image")
            fail([...at, "fitBackground", "assetId"], "the background must be an image");
        }
        const asset = assets.get(clip.assetId);
        if (!asset) return fail([...at, "assetId"], `unknown asset "${clip.assetId}"`);
        if (track.type === "audio" && asset.type !== "audio") {
          fail([...at, "assetId"], `${asset.type} asset cannot be placed on an audio track`);
        }
        if (track.type === "video" && asset.type === "audio") {
          fail([...at, "assetId"], "audio asset cannot be placed on a video track");
        }
        if (asset.duration !== undefined && clip.sourceOut > asset.duration + DURATION_EPSILON) {
          fail([...at, "sourceOut"], `sourceOut exceeds asset duration (${asset.duration}s)`);
        }
      });
    });
  });

export type FitBackground = z.infer<typeof FitBackgroundSchema>;
export type FitMode = NonNullable<z.infer<typeof TimelineClipSchema>["fitMode"]>;
export type MediaType = z.infer<typeof MediaTypeSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
export type TimelineTrack = z.infer<typeof TimelineTrackSchema>;
export type Project = z.infer<typeof ProjectSchema>;
