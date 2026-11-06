// The projects axis: one table shared by items, notes, and goals. Assignment
// is housekeeping (not logged) — see projects.rs and AGENTS.md "Projects".

export interface Project {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}
