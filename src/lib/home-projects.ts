// J.A.B.S Home vs Projects — pure helpers/hook-point types (no side effects).
// Wire into app.ts per research/home-projects-2026-11-13.md (ViewName, scope, boot).

export type ConsoleScope = 'home' | 'project';

export interface HomeSpace {
  companyId: string;
  goalId: string;
  homeGoalId?: string;
}

export interface ProjectCardModel {
  id: string;
  title: string;
  slug?: string;
  stack?: string;
  access_level?: string;
  status?: string;
  is_home?: boolean | number;
}

export function isHomeProject(p: Pick<ProjectCardModel, 'id' | 'title' | 'slug' | 'is_home'>, homeGoalId?: string): boolean {
  if (!p) return false;
  if (homeGoalId && p.id === homeGoalId) return true;
  if (p.is_home === 1 || p.is_home === true) return true;
  if (p.slug === 'home') return true;
  return p.title === 'Home' || p.title === 'Siempre';
}

export function filterProjectCards(projects: ProjectCardModel[], homeGoalId?: string): ProjectCardModel[] {
  return (projects || []).filter((p) => !isHomeProject(p, homeGoalId));
}

export function scopeLabels(scope: ConsoleScope, projectTitle?: string): {
  contextLabel: string;
  workTitle: string;
  railName: string;
  railMeta: string;
} {
  if (scope === 'home') {
    return {
      contextLabel: 'Home',
      workTitle: 'Home',
      railName: 'Pablo',
      railMeta: 'Personal assistant'
    };
  }
  const name = projectTitle || 'Project';
  return {
    contextLabel: 'Project',
    workTitle: name,
    railName: name,
    railMeta: 'Project team'
  };
}
