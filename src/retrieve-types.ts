export interface RetrieveInput {
  query: string;
  limit?: number;
  org_id?: string;
  session_id?: string;
  trace_id?: string;
  intent?: string;
  task?: string;
  description?: string;
  language?: string;
  stack?: string[];
  technologies?: string[];
  frameworks?: string[];
  deps?: string[];
  errorStrings?: string[];
  recentActivity?: string[];
  buildFailing?: boolean;
  testFailing?: boolean;
  files?: string[];
  directory?: string;
  projectName?: string;
  relevance_floor?: number;
  surface_budget?: number;
  mc_version?: number;
}
