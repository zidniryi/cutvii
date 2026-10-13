/**
 * The text of the "Support CutVii" popup, from the one file `config/support.json`. A file that is broken
 * falls back to the built-in English text. The two links are opened by Rust, which checks them itself
 * (`src-tauri/src/commands/support.rs`); nothing here is ever followed as a link.
 */
import { z } from "zod";
import raw from "../../config/support.json";

const text = z.string().trim().min(1).max(1000);
const LocaleSchema = z
  .object({ title: text, message: text, donate: text, other: text, otherLine: text, footer: text })
  .strict();
export type SupportText = z.infer<typeof LocaleSchema>;

const ConfigSchema = z.object({
  donateUrl: z.string(),
  supportUrl: z.string(),
  locales: z.object({ en: LocaleSchema }).catchall(LocaleSchema),
});

export const DEFAULT_TEXT: SupportText = {
  title: "Support CutVii",
  message:
    "CutVii is free and open source, and it will stay that way. If it has been useful to you, a small donation helps us keep building it. Supporters get extra template packs (fonts, presets and caption styles), priority support, the chance to suggest new features, and, if you wish, a public thank-you on our social media. Every bit of support is truly appreciated. Thank you!",
  donate: "Donate",
  other: "Other ways to support",
  otherLine: "Star us on GitHub, follow us on YouTube, X and more. It is free and it means a lot.",
  footer: "No pressure. CutVii works the same for everyone.",
};

/** The text for an OS language tag such as "id-ID": that language if the file has it, otherwise English. */
export function supportText(language: string | undefined, config: unknown = raw): SupportText {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) return DEFAULT_TEXT;
  const code = (language ?? "").toLowerCase().split(/[-_]/)[0];
  const locales: Record<string, SupportText> = parsed.data.locales;
  return (Object.hasOwn(locales, code) ? locales[code] : undefined) ?? locales.en;
}
