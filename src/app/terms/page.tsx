import { readFile } from "node:fs/promises";
import path from "node:path";
import { LegalPageShell } from "@/components/LegalPageShell";
import { cleanLegalMarkdown } from "@/lib/legal-doc";

export const metadata = {
  title: "Terms of Service — OpenBooks",
  description: "OpenBooks Terms of Service (draft).",
};

// Static: the legal/*.md is read at build time and baked into the page, so the
// file is not needed at runtime.
export default async function TermsPage() {
  const raw = await readFile(path.join(process.cwd(), "legal", "terms-of-service.md"), "utf8");
  return <LegalPageShell markdown={cleanLegalMarkdown(raw)} />;
}
