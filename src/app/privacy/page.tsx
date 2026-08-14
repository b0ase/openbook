import { readFile } from "node:fs/promises";
import path from "node:path";
import { LegalPageShell } from "@/components/LegalPageShell";
import { cleanLegalMarkdown } from "@/lib/legal-doc";

export const metadata = {
  title: "Privacy Policy — OpenBook",
  description: "OpenBook Privacy Policy (draft).",
};

// Static: the legal/*.md is read at build time and baked into the page.
export default async function PrivacyPage() {
  const raw = await readFile(path.join(process.cwd(), "legal", "privacy-policy.md"), "utf8");
  return <LegalPageShell markdown={cleanLegalMarkdown(raw)} />;
}
