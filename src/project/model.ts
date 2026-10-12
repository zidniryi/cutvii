import { z } from "zod";

/** Bump when the on-disk shape changes, and add a migration in `src-tauri/src/project/migrate.rs`. v2: clip speed. v3: fitMode. v4: fitBackground. v5: text assets. v6: clip crop, text font, rotation and flip, clip mute and fades, clip colour, text styles. */
export const SCHEMA_VERSION = 6;

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

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #RRGGBB color");
const share = z.number().min(0).max(1);
const offset = z.number().min(-1).max(1);

/**
 * The style parts of a text. Sizes are shares of the font size, so a style looks the same at any size.
 * Drawn by Rust (`media/text.rs` + `media/text_fx.rs`): the same picture serves preview and export.
 */
const textLook = {
  /** Draw the text in capitals (the stored text keeps its own case). */
  uppercase: z.boolean().optional(),
  /** A line of another colour around the letters. */
  outline: z
    .object({ color: hexColor, width: z.number().gt(0).max(0.5) })
    .strict()
    .optional(),
  /** A shadow behind the letters; with no offset and a bright colour it is a glow. */
  shadow: z
    .object({ color: hexColor, blur: share, x: offset, y: offset, opacity: share })
    .strict()
    .optional(),
  /** A filled shape behind the text: one box, one per line, or a box with zigzag sides. */
  box: z
    .object({
      color: hexColor,
      opacity: share,
      shape: z.enum(["rect", "per-line", "jagged"]),
      padding: share,
      radius: share,
    })
    .strict()
    .optional(),
  /** Some lines drawn in another colour. */
  highlight: z
    .object({ color: hexColor, lines: z.enum(["last", "first", "even"]) })
    .strict()
    .optional(),
};

/**
 * Text and titles. The same limits are enforced in Rust (`src-tauri/src/media/text.rs`), which draws the text
 * onto a transparent picture the size of the canvas.
 */
export const TextSpecSchema = z
  .object({
    content: z
      .string()
      .max(2000, "Text can be 2000 characters at most")
      .refine((s) => s.trim().length > 0, "Text must not be empty"),
    /** Height of the font in canvas pixels. */
    fontSize: z.number().min(8, "Font size must be 8 to 2000").max(2000, "Font size must be 8 to 2000"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #RRGGBB color"),
    bold: z.boolean().optional(),
    /** Font family name; absent means Noto Sans. A family that is not installed is drawn in Noto Sans. */
    font: z.string().trim().min(1).max(100).optional(),
    /** Absent means "center". */
    align: z.enum(["left", "center", "right"]).optional(),
    /** Centre of the text block as a share of the canvas (0.5, 0.5 = the middle). */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    /** Lines wrap at this share of the canvas width; absent means 0.9. Subtitles use their picture's width. */
    wrap: z.number().min(0.05).max(1).optional(),
    ...textLook,
  })
  .strict();

/** The look of a text without its words, size or place: what a style preset carries. */
export const TextStyleSchema = z
  .object({
    color: hexColor,
    bold: z.boolean().optional(),
    font: z.string().trim().min(1).max(100).optional(),
    ...textLook,
  })
  .strict();

/** A ready-made text style from `presets/text-styles.json` (Rust reads the same file). */
export const StylePresetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    style: TextStyleSchema,
    /** Seconds the text fades in and out over, when the style calls for it. */
    fade: z.number().min(0).max(5).optional(),
    /** What the style is good for ("clipper" = short vertical clips; "word-timing" = wants per-word times). */
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    /** Set on a style that came from someone else's file or pack. */
    source: z.literal("imported").optional(),
  })
  .strict();

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
    /** A text picture drawn by CutVii from these properties; `path` is the drawn picture. Images only. */
    text: TextSpecSchema.optional(),
  })
  .strict()
  .refine((a) => a.text === undefined || a.type === "image", {
    message: "only an image asset can be text",
    path: ["text"],
  })
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

/** The most that can be cropped away along one axis (both sides together). Same in Rust. */
export const MAX_CROP = 0.9;
const cropSide = z.number().min(0).max(MAX_CROP);

/** Shares of the source picture removed from each side before it is scaled to the canvas. */
export const CropSchema = z
  .object({ left: cropSide, top: cropSide, right: cropSide, bottom: cropSide })
  .strict()
  .refine((c) => c.left + c.right <= MAX_CROP + 1e-9 && c.top + c.bottom <= MAX_CROP + 1e-9, {
    message: "at least a tenth of the picture must remain",
  });

const colorValue = z.number().min(-1).max(1);

/**
 * Colour adjustment: each value runs from -1 to 1 and 0 changes nothing. Rust bakes them into one lookup
 * table (`src-tauri/src/media/color.rs`) that both the preview and the export apply.
 */
export const ColorAdjustSchema = z
  .object({
    exposure: colorValue,
    contrast: colorValue,
    saturation: colorValue,
    vibrance: colorValue,
    temperature: colorValue,
    tint: colorValue,
    highlights: colorValue,
    shadows: colorValue,
  })
  .strict();

/** The longest fade that can be stored (seconds). Same in Rust. A fade longer than its clip is shortened. */
export const MAX_FADE = 60;

/** Limits of the clip transform. The same numbers are enforced in Rust (`project/model.rs`). */
export const TRANSFORM_LIMITS = { offset: 2, minScale: 0.05, maxScale: 4, rotation: 180 } as const;

export const TimelineClipSchema = z
  .object({
    id: Id,
    assetId: Id,
    trackId: Id,
    timelineStart: z.number().nonnegative(),
    sourceIn: z.number().nonnegative(),
    sourceOut: z.number().nonnegative(),
    volume: z.number().min(0).max(MAX_VOLUME),
    /** Offset of the clip's layer as a share of the canvas (0.1 = a tenth of its width right / height down). */
    x: z.number().min(-TRANSFORM_LIMITS.offset).max(TRANSFORM_LIMITS.offset),
    y: z.number().min(-TRANSFORM_LIMITS.offset).max(TRANSFORM_LIMITS.offset),
    /** 1 is the fitted size. */
    scale: z.number().min(TRANSFORM_LIMITS.minScale).max(TRANSFORM_LIMITS.maxScale),
    opacity: z.number().min(0).max(1),
    /** Clockwise rotation in degrees; absent means 0. */
    rotation: z.number().min(-TRANSFORM_LIMITS.rotation).max(TRANSFORM_LIMITS.rotation).optional(),
    /** Mirror left-right / top-bottom; absent means false. */
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
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
    /** This clip makes no sound (its picture still shows); absent means false. */
    muted: z.boolean().optional(),
    /** Seconds of fade at the start / end of the clip's sound, on the timeline; absent means 0. */
    fadeIn: z.number().min(0).max(MAX_FADE).optional(),
    fadeOut: z.number().min(0).max(MAX_FADE).optional(),
    /** Edges of the picture cut away; absent means none. */
    crop: CropSchema.optional(),
    /** The Adjust sliders of the Color tab; absent means the picture is left as it is. */
    color: ColorAdjustSchema.optional(),
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
        // a video on an audio track is its detached sound; a still has none
        if (track.type === "audio" && asset.type === "image") {
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

export type ColorAdjust = z.infer<typeof ColorAdjustSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type TextSpec = z.infer<typeof TextSpecSchema>;
export type TextStyle = z.infer<typeof TextStyleSchema>;
export type StylePreset = z.infer<typeof StylePresetSchema>;
export type FitBackground = z.infer<typeof FitBackgroundSchema>;
export type FitMode = NonNullable<z.infer<typeof TimelineClipSchema>["fitMode"]>;
export type MediaType = z.infer<typeof MediaTypeSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
export type TimelineTrack = z.infer<typeof TimelineTrackSchema>;
export type Project = z.infer<typeof ProjectSchema>;
