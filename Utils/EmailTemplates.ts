import path from "path";

const resolveTemplatePath = (templateName: string) =>
  path.join(process.cwd(), "Views", "emails", templateName);

let cachedEjs: any = null;
const loadEjs = async () => {
  if (cachedEjs) return cachedEjs;
  const mod: any = await import("ejs");
  cachedEjs = mod?.default || mod;
  return cachedEjs;
};

export const renderEmailTemplate = async (
  templateName: string,
  data: Record<string, unknown>
): Promise<string> => {
  const templatePath = resolveTemplatePath(templateName);
  const ejs = await loadEjs();
  return ejs.renderFile(templatePath, data);
};
