import {
  FileArchive,
  FileBlank,
  FileBraces,
  FileCodePage,
  FileCog,
  FileDatabase,
  FileImage,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  type IconComponent,
} from "../../../../lib/icons";

export type FileIconKind =
  | "code"
  | "data"
  | "config"
  | "text"
  | "image"
  | "shell"
  | "database"
  | "table"
  | "archive"
  | "file";

const CODE_EXTS = new Set([
  "ts", "tsx", "mts", "cts",
  "js", "jsx", "mjs", "cjs",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "swift", "scala",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hxx", "cs", "m", "mm", "zig",
  "php", "lua", "pl", "ex", "exs", "erl", "hs", "clj", "dart", "r",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "graphql", "gql",
]);

const DATA_EXTS = new Set(["json", "jsonc", "json5", "ndjson", "jsonl", "geojson"]);

const CONFIG_EXTS = new Set([
  "yml", "yaml", "toml", "xml", "plist", "ini", "cfg", "conf", "env",
  "properties", "lock", "nix", "tf", "tfvars", "hcl", "gradle",
  "xcconfig", "entitlements",
]);

const CONFIG_NAMES = new Set([
  ".env", ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig",
  ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc", ".dockerignore",
  "dockerfile", "makefile", "cmakelists.txt", "gemfile", "podfile",
  "procfile", "brewfile",
]);

const TEXT_EXTS = new Set([
  "md", "mdx", "markdown", "txt", "rst", "adoc", "rtf", "log",
  "pdf", "doc", "docx", "tex",
]);

const TEXT_NAMES = new Set([
  "readme", "license", "licence", "copying", "changelog", "authors", "notice",
]);

const IMAGE_EXTS = new Set([
  "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "icns",
  "bmp", "avif", "tif", "tiff", "heic",
]);

const SHELL_EXTS = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "ps1", "psm1", "psd1", "bat", "cmd",
]);

const DATABASE_EXTS = new Set(["sql", "sqlite", "sqlite3", "db", "prisma"]);

const TABLE_EXTS = new Set(["csv", "tsv", "xls", "xlsx", "ods"]);

const ARCHIVE_EXTS = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "dmg", "pkg", "deb", "rpm", "appimage", "asar",
]);

const KIND_ICONS: Record<FileIconKind, IconComponent> = {
  code: FileCodePage,
  data: FileBraces,
  config: FileCog,
  text: FileText,
  image: FileImage,
  shell: FileTerminal,
  database: FileDatabase,
  table: FileSpreadsheet,
  archive: FileArchive,
  file: FileBlank,
};

/** Classifies a file name or path into its Hugeicons file-category icon. */
export function fileIconKind(filename: string): FileIconKind {
  const base = (filename.split(/[\\/]/).pop() ?? filename).trim().toLowerCase();
  if (!base) return "file";

  if (CONFIG_NAMES.has(base) || base.startsWith(".env.") || base.startsWith("dockerfile.")) {
    return "config";
  }
  if (TEXT_NAMES.has(base)) return "text";

  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  if (!ext) return "file";

  if (CODE_EXTS.has(ext)) return "code";
  if (DATA_EXTS.has(ext)) return "data";
  if (CONFIG_EXTS.has(ext)) return "config";
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (SHELL_EXTS.has(ext)) return "shell";
  if (DATABASE_EXTS.has(ext)) return "database";
  if (TABLE_EXTS.has(ext)) return "table";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  return "file";
}

export function FileExtIcon({
  filename,
  className,
}: {
  filename: string;
  className?: string;
}) {
  const Icon = KIND_ICONS[fileIconKind(filename)];
  return <Icon size={16} strokeWidth={1.6} className={className ?? "w-4 h-4 shrink-0"} />;
}
