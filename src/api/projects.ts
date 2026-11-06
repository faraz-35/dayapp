// Projects: a second organising axis alongside Sections. Assignment is
// housekeeping (not logged), mirroring the hide affordance.

import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types/project";

export const projectsApi = {
  list: () => invoke<Project[]>("list_projects"),
  create: (name: string) => invoke<Project>("create_project", { name }),
  rename: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  delete: (id: string) => invoke<void>("delete_project", { id }),
};
