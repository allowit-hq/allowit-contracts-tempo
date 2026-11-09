import {tempoMppResponseLabel, type TempoMppView} from './tempo-mpp';

/** A chain payment and an executor's HTTP response report are separate facts. No response body is displayed. */
export default function TempoPurchaseDetails({purchase}: {purchase: TempoMppView}) {
  if (!purchase.available) return <p className="small muted tempo-purchase-note">Purchase details unavailable. The payment status is shown separately.</p>;
  const {response} = purchase;
  const reported = response.status === 'response_reported' || response.status === 'response_unavailable';
  return <div className="tempo-purchase">
    <dl className="facts tempo-purchase-facts">
      <div><dt>Service</dt><dd><a className="mono tempo-wrap" href={purchase.url} target="_blank" rel="noreferrer">GET {purchase.url}</a></dd></div>
      <div><dt>Origin</dt><dd className="mono tempo-wrap">{purchase.origin}</dd></div>
      <div><dt>Response</dt><dd>{tempoMppResponseLabel(response)}{response.httpStatus !== null ? ` · HTTP ${response.httpStatus}` : ''}{reported ? <span className="tempo-review-note">Executor report</span> : null}</dd></div>
    </dl>
    <p className="small muted tempo-purchase-note">{reported ? 'Reported by the executor. Service delivery is not independently verified.' : 'A confirmed payment does not establish that the service returned a response.'}</p>
  </div>;
}
