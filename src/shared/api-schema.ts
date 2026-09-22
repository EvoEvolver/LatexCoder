import { z } from "zod";

export const usernameSchema = z.string().trim().min(1).max(64);
export const passwordSchema = z.string().min(10).max(1024);
export const projectNameSchema = z.string().trim().min(1).max(120);

export const loginRequestSchema = z.strictObject({ username: usernameSchema, password: z.string() });
export const registerRequestSchema = z.strictObject({ token: z.string().min(1), username: usernameSchema, password: passwordSchema });
export const updateProfileRequestSchema = z.strictObject({ displayName: z.string().trim().min(1).max(80) });
export const createProjectRequestSchema = z.strictObject({ name: projectNameSchema });
export const updateProjectRequestSchema = createProjectRequestSchema;
export const settingsRequestSchema = z.strictObject({
  main: z.string().min(1),
  compiler: z.enum(["auto", "tectonic", "latexmk"]),
  autoCompile: z.boolean(),
});
export const compileRequestSchema = z.strictObject({ main: z.string().optional() });

export const currentUserSchema = z.object({ username: z.string(), displayName: z.string() });
export const projectFileSchema = z.object({ path: z.string(), size: z.number(), text: z.boolean() });
export const editorSettingsSchema = z.object({ main: z.string(), autoCompile: z.boolean(), compiler: z.string() });
export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
  lastOpenedAt: z.string().optional(),
  membership: z.string().optional(),
  permissions: z.object({ manage: z.boolean().optional(), edit: z.boolean().optional(), collaborate: z.boolean().optional() }).optional(),
});
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) });
export const blameRunSchema = z.object({
  from: z.number(), to: z.number(), authorId: z.string(), authorName: z.string(), changeId: z.string(),
  createdAt: z.number().nullable(), commit: z.string().nullable(),
});
export const blameResponseSchema = z.object({ path: z.string(), revision: z.string(), runs: z.array(blameRunSchema) });

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type SettingsRequest = z.infer<typeof settingsRequestSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type EditorSettings = z.infer<typeof editorSettingsSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type BlameRun = z.infer<typeof blameRunSchema>;
