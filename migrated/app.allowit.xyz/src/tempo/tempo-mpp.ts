import {checkedTempoOperation, sameAddress, type TempoConfig, type TempoOperation, type TempoPolicy} from './tempo-contracts';

export type TempoMppResponse = {status: 'not_reported' | 'report_unavailable' | 'response_reported' | 'response_unavailable'; httpStatus: number | null};
export type TempoMppView = {available: false} | {available: true; url: string; origin: string; response: TempoMppResponse};

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const digest = (value: unknown) => typeof value === 'string' && /^0x[a-f\d]{64}$/i.test(value);
const sameDigest = (a: unknown, b: unknown) => digest(a) && digest(b) && String(a).toLowerCase() === String(b).toLowerCase();
const positiveUnits = (value: unknown) => typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value) && BigInt(value) <= (1n << 256n) - 1n;
const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

/** Public display only. Optional purchase/report failures must never reject verified owner custody or a chain receipt. */
export function tempoMppView(operation: TempoOperation, policy: TempoPolicy, config: TempoConfig): TempoMppView | undefined {
  if (operation.purchase === undefined || operation.purchase === null) return undefined;
  try {
    checkedTempoOperation(operation, policy.id, policy, config);
    const purchase = object(operation.purchase);
    if (!purchase || operation.method !== 'execute' || purchase.protocol !== 'mpp' || purchase.method !== 'GET'
      || typeof purchase.url !== 'string' || purchase.url.length > 2048 || /[?#]/.test(purchase.url) || typeof purchase.origin !== 'string'
      || purchase.chainId !== 42431 || purchase.chainId !== policy.chainId || purchase.chainId !== config.chainId || !sameAddress(purchase.token, policy.token)
      || !sameAddress(purchase.recipient, operation.execution?.recipient) || !positiveUnits(purchase.amountUnits)
      || purchase.amountUnits !== operation.execution?.amountUnits || !digest(purchase.requestDigest) || !digest(purchase.challengeDigest)
      || typeof purchase.memo !== 'string' || !/^0x[a-f\d]{64}$/i.test(purchase.memo)
      || (purchase.challengeExpiresAt !== undefined && (!Number.isSafeInteger(purchase.challengeExpiresAt) || Number(purchase.challengeExpiresAt) <= 0))) return {available: false};
    const url = new URL(purchase.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== purchase.url || url.origin !== purchase.origin) return {available: false};
    let response: TempoMppResponse = {status: 'not_reported', httpStatus: null};
    if (operation.delivery !== undefined && operation.delivery !== null) {
      const report = object(operation.delivery);
      const receipt = object(report?.receipt);
      const reportedResponse = report?.status !== 'response_reported' || (Number(report.httpStatus) >= 200 && Number(report.httpStatus) <= 299
        && receipt?.status === 'success' && receipt.method === 'tempo' && typeof receipt.reference === 'string'
        && receipt.reference.toLowerCase() === operation.transactionHash?.toLowerCase() && timestamp(receipt.timestamp)
        && digest(report.responseDigest) && Number.isInteger(report.responseBytes) && Number(report.responseBytes) >= 0 && Number(report.responseBytes) <= 65536);
      const valid = report && operation.status === 'settled' && report.reportedBy === 'executor'
        && ['response_reported', 'response_unavailable'].includes(String(report.status))
        && typeof report.transactionHash === 'string' && /^0x[a-f\d]{64}$/i.test(report.transactionHash)
        && report.transactionHash.toLowerCase() === operation.transactionHash?.toLowerCase()
        && sameDigest(report.challengeDigest, purchase.challengeDigest)
        && timestamp(report.reportedAt) && reportedResponse
        && (report.httpStatus === undefined || (Number.isInteger(report.httpStatus) && Number(report.httpStatus) >= 200 && Number(report.httpStatus) <= 599));
      response = valid ? {status: report.status as 'response_reported' | 'response_unavailable', httpStatus: report.httpStatus === undefined ? null : Number(report.httpStatus)} : {status: 'report_unavailable', httpStatus: null};
    }
    return {available: true, url: url.href, origin: url.origin, response};
  } catch {return {available: false};}
}

export function tempoMppResponseLabel(response: TempoMppResponse): string {
  return response.status === 'response_reported' ? 'Response reported' : response.status === 'response_unavailable' ? 'Response unavailable'
    : response.status === 'report_unavailable' ? 'Response report unavailable' : 'Response not reported';
}
