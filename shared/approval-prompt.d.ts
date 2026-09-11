export const APPROVAL_DETAIL_LIMIT: number;
export function truncateApprovalDetail(detail: string, limit?: number): string;
export function buildApprovalPrompt(heading: string, detail: string, limit?: number): string;
export function splitApprovalPrompt(title: string): { heading: string; detail: string };
