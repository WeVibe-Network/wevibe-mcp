export interface MemoryStats {
  retrieval_count: number;
  acceptance_count: number;
}

export interface ContributorStats {
  account_age_days: number;
  contributions: number;
  serve_count: number;
  reports_upheld: number;
  false_reports_against: number;
}

export interface MemoryWithStats {
  content: string;
  memory_stats: MemoryStats;
  contributor_stats: ContributorStats;
}

export function formatAccountAge(days: number): string {
  if (days < 7) return `${days}d`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    const remainDays = days % 7;
    return remainDays > 0 ? `${weeks}w ${remainDays}d` : `${weeks}w`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    const remainDays = days % 30;
    return remainDays > 0 ? `${months}m ${remainDays}d` : `${months}m`;
  }
  const years = Math.floor(days / 365);
  const remainMonths = Math.floor((days % 365) / 30);
  return remainMonths > 0 ? `${years}y ${remainMonths}m` : `${years}y`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatTrustPanel(memory: MemoryWithStats): string {
  const ms = memory.memory_stats;
  const cs = memory.contributor_stats;

  return [
    memory.content,
    '',
    'memory stats:',
    `  retrieved: ${formatNumber(ms.retrieval_count)}`,
    `  accepted: ${formatNumber(ms.acceptance_count)}`,
    '',
    'contributor stats:',
    `  account age: ${formatAccountAge(cs.account_age_days)}`,
    `  contributions: ${formatNumber(cs.contributions)}`,
    `  serves: ${formatNumber(cs.serve_count)}`,
    `  reports upheld: ${formatNumber(cs.reports_upheld)}`,
    `  false reports against: ${formatNumber(cs.false_reports_against)}`,
  ].join('\n');
}