import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { stockQuantity, sortedStockItems, isTransientStockError } from './stockUtils.js';
import './catalogStock.css';

export function useCatalogStock(client, userId, enabled) {
  const [rows, setRows] = useState({});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setRows({}); setError(''); setStatus('loading');
    if (!enabled || !userId) return;
    let inFlight = false;
    let loaded = false;
    let failures = 0;
    let controller;
    let lastStarted = 0;
    async function load(force = false) {
      if (inFlight || document.hidden || (!force && Date.now() - lastStarted < 5000)) return;
      inFlight = true;
      lastStarted = Date.now();
      try {
        let data;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (version !== generation.current) return;
          controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const result = await client.rpc('get_catalog_stock').abortSignal(controller.signal);
            if (result.error) throw result.error;
            data = result.data;
            break;
          } catch (failure) {
            if (attempt === 2 || !isTransientStockError(failure)) throw failure;
            await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
          } finally { clearTimeout(timeout); }
        }
        if (version === generation.current) {
          loaded = true; failures = 0;
          setRows(Object.fromEntries((data || []).map(row => [String(row.machine_id), row])));
          setStatus('ready'); setError('');
        }
      } catch (failure) {
        if (version !== generation.current) return;
        failures++;
        if (isTransientStockError(failure) && loaded) {
          // A background network failure does not invalidate a successful snapshot.
          setStatus('ready');
          setError(failures >= 3 ? 'Stock refresh is delayed. Showing the last loaded quantities; retrying automatically.' : '');
        } else {
          setStatus('error');
          setError(isTransientStockError(failure)
            ? 'Cannot connect to stock right now. Retrying automatically.'
            : 'Stock access could not be verified. Please sign in again or contact the admin.');
          if (!isTransientStockError(failure)) { loaded = false; setRows({}); }
        }
      } finally { inFlight = false; }
    }
    load(true);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = setInterval(() => load(), 30000);
    return () => {
      generation.current++; controller?.abort(); clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [client, userId, enabled]);
  async function save(changes) {
    if (!enabled || status !== 'ready') throw new Error('Stock access is not ready.');
    const version = generation.current;
    const { data, error: failure } = await client.rpc('save_catalog_stock', { changes });
    if (failure) {
      // Refresh after a conflict so reopening starts with the server's quantity.
      const refreshed = await client.rpc('get_catalog_stock');
      if (!refreshed.error && version === generation.current) {
        setRows(Object.fromEntries((refreshed.data || []).map(row => [String(row.machine_id), row])));
      }
      throw failure;
    }
    if (version === generation.current) setRows(previous => ({ ...previous, ...Object.fromEntries(data.map(row => [String(row.machine_id), row])) }));
  }
  return { rows, status, error, save };
}

function Quantity({ value, onChange, name, disabled }) {
  const adjust = delta => {
    let current;
    try { current = stockQuantity(value === '' ? 0 : value); } catch { return; }
    onChange(String(Math.max(0, Math.min(2147483647, current + delta))));
  };
  return <span className="stock-quantity">
    <button type="button" className="stock-reveal" aria-label={`Decrease stock for ${name}`} disabled={disabled} onClick={() => adjust(-1)}>−</button>
    <input aria-label={`Stock quantity for ${name}`} type="number" min="0" max="2147483647" step="1" inputMode="numeric" placeholder="Not set" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
    <button type="button" className="stock-reveal" aria-label={`Increase stock for ${name}`} disabled={disabled} onClick={() => adjust(1)}>+</button>
  </span>;
}

export function StockEditor({ items, stock, onClose, title = 'Update stock' }) {
  const [baseline] = useState(() => Object.fromEntries(items.map(item => [String(item.id), stock.rows[String(item.id)] || null])));
  const [values, setValues] = useState(() => Object.fromEntries(items.map(item => [String(item.id), baseline[String(item.id)]?.quantity ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  useEffect(() => { const node = dialog.current; node.showModal(); return () => node.close(); }, []);
  const sorted = sortedStockItems(items);
  const changed = items.filter(item => String(values[String(item.id)]) !== String(baseline[String(item.id)]?.quantity ?? ''));
  async function submit(event) {
    event.preventDefault(); setError('');
    try {
      const changes = changed.map(item => ({ machine_id: String(item.id), quantity: stockQuantity(values[String(item.id)]), expected_updated_at: baseline[String(item.id)]?.updated_at ?? null }));
      if (!changes.length) { onClose(); return; }
      setBusy(true); await stock.save(changes); onClose();
    } catch (failure) { setError(failure.message || 'Stock was not saved.'); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="stock-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Close stock editor">×</button></header>
      <p>Set the current quantity. Changes are saved together when you select Save.</p>
      <div className="stock-table-wrap"><table><thead><tr><th>Product name</th><th>MRP</th><th>Stock</th></tr></thead><tbody>
        {sorted.map((item, index) => <React.Fragment key={item.id}>
          {(index === 0 || (item.category || 'Uncategorized') !== (sorted[index - 1].category || 'Uncategorized')) && <tr className="stock-category"><th colSpan="3">{item.category || 'Uncategorized'}</th></tr>}
          <tr><td>{item.name}</td><td>₹{Number(item.mrp || 0).toLocaleString('en-IN')}</td><td><Quantity name={item.name} value={values[String(item.id)]} disabled={busy} onChange={value => setValues(previous => ({ ...previous, [String(item.id)]: value }))} /></td></tr>
        </React.Fragment>)}
      </tbody></table></div>
      {error && <p role="alert" className="stock-error">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy || !changed.length}>{busy ? 'Saving…' : 'Save stock'}</button></footer>
    </form>
  </dialog>, document.body);
}

export function StockLine({ item, stock, onEdit }) {
  const row = stock.rows[String(item.id)];
  return <div className="stock-line">
    <span>Stock: <strong>{stock.status === 'loading' ? '…' : stock.status === 'error' ? 'Unavailable' : row?.quantity ?? 'Not set'}</strong></span>
    <button type="button" className="stock-reveal" disabled={stock.status !== 'ready'} onClick={onEdit} aria-label={`Update stock for ${item.name}`} title="Update stock">✎</button>
    {row?.updated_at && <span>Last updated {new Date(row.updated_at).toLocaleDateString('en-IN')}</span>}
  </div>;
}
