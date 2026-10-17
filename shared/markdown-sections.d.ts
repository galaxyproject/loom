export function markdownSections(
  content: string | null | undefined,
): { heading: string; content: string }[];
export function applySectionEdit(
  original: string | null | undefined,
  heading: string,
  section: string,
): string;
export function sectionsHeaded(content: string | null | undefined, heading: string): string[];
