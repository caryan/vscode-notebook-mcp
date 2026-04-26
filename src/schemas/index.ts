import { z } from "zod";

export const ResponseFormat = {
  Markdown: "markdown",
  JSON: "json"
} as const;

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format");

export const NotebookUriSchema = z
  .string()
  .optional()
  .describe(
    "Notebook URI to target. If omitted, the active notebook is used. Use notebook_list_open to discover URIs."
  );

export const CellIndexSchema = z
  .number()
  .int()
  .min(0)
  .describe("Zero-based cell index");
