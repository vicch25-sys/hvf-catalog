import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { stockQuantity, sortedStockItems, isTransientStockError } from './stockUtils.js';
import './catalogStock.css';

export function useCatalogStock(client, userId, enabled) {
  const [rows, setRows] = useState({});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refreshRef = useRef(null);
  const revision = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setRows({}); setError(''); setStatus('loading');
    if (!enabled || !userId) return;
    let pending = null;
    let loaded = false;
    let controller;
    let lastStarted = 0;
    function load() {
      if (pending) return pending;
      lastStarted = Date.now();
      const readRevision = revision.current;
      pending = (async () => {
        try {
          let data;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (version !== generation.current) throw new Error('Session changed.');
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
          if (version !== generation.current) throw new Error('Session changed.');
          const snapshot = Object.fromEntries((data || []).map(row => [String(row.machine_id), row]));
          loaded = true;
          if (readRevision === revision.current) setRows(snapshot);
          setStatus('ready'); setError('');
          return snapshot;
        } catch (failure) {
          if (version === generation.current) {
            if (isTransientStockError(failure) && loaded) {
              setStatus('ready');
              setError('Showing last loaded stock. Open Update stock to refresh before editing.');
            } else {
              setStatus('error');
              setError(isTransientStockError(failure)
                ? 'Stock could not connect. Open Update stock to retry.'
                : 'Stock access could not be verified. Please sign in again or contact the admin.');
              if (!isTransientStockError(failure)) { loaded = false; setRows({}); }
            }
          }
          throw failure;
        } finally { pending = null; }
      })();
      return pending;
    }
    refreshRef.current = load;
    load().catch(() => {});
    // Refresh on returning to the app, not on a timer or every window focus.
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastStarted >= 60000) load().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current++; controller?.abort(); refreshRef.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, userId, enabled]);
  function refresh() {
    return refreshRef.current ? refreshRef.current() : Promise.reject(new Error('Sign in to access stock.'));
  }
  async function save(changes) {
    if (!enabled || status !== 'ready') throw new Error('Stock access is not ready.');
    const version = generation.current;
    revision.current++;
    const { data, error: failure } = await client.rpc('save_catalog_stock', { changes });
    if (failure) throw new Error(isTransientStockError(failure)
      ? 'Could not confirm the save. Close and reopen the editor to check the saved quantity before retrying.'
      : failure.message || 'Stock was not saved.');
    revision.current++;
    if (version === generation.current) {
      setRows(previous => ({ ...previous, ...Object.fromEntries(data.map(row => [String(row.machine_id), row])) }));
      setError('');
    }
  }
  return { rows, status, error, save, refresh };
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
  const [search, setSearch] = useState('');
  const [baseline, setBaseline] = useState({});
  const [ready, setReady] = useState(false);
  const [values, setValues] = useState(() => Object.fromEntries(items.map(item => [String(item.id), baseline[String(item.id)]?.quantity ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current; node.showModal();
    let active = true;
    stock.refresh().then(snapshot => {
      if (!active) return;
      const latest = Object.fromEntries(items.map(item => [String(item.id), snapshot[String(item.id)] || null]));
      setBaseline(latest);
      setValues(Object.fromEntries(items.map(item => [String(item.id), latest[String(item.id)]?.quantity ?? ''])));
      setReady(true);
    }).catch(() => { if (active) setError('Cannot load current stock. Close and reopen to retry when connected.'); });
    return () => { active = false; node.close(); };
  }, []);
  const keywords = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const sorted = sortedStockItems(items).filter(item =>
    keywords.every(keyword => String(item.name || '').toLocaleLowerCase().includes(keyword)));
  const changed = items.filter(item => String(values[String(item.id)]) !== String(baseline[String(item.id)]?.quantity ?? ''));
  async function submit(event) {
    event.preventDefault(); if (!ready) return; setError('');
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
      <input className="stock-search" type="search" aria-label="Search stock by product name" placeholder="Search product name or keywords…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
      {search.trim() && <p role="status">{sorted.length} of {items.length} products · All edited quantities will be saved.</p>}
      {!ready && !error && <p role="status">Loading current stock…</p>}
      <div className="stock-table-wrap"><table><thead><tr><th>Product name</th><th>MRP</th><th>Stock</th></tr></thead><tbody>
        {sorted.map((item, index) => <React.Fragment key={item.id}>
          {(index === 0 || (item.category || 'Uncategorized') !== (sorted[index - 1].category || 'Uncategorized')) && <tr className="stock-category"><th colSpan="3">{item.category || 'Uncategorized'}</th></tr>}
          <tr><td>{item.name}</td><td>₹{Number(item.mrp || 0).toLocaleString('en-IN')}</td><td><Quantity name={item.name} value={values[String(item.id)]} disabled={busy || !ready} onChange={value => setValues(previous => ({ ...previous, [String(item.id)]: value }))} /></td></tr>
        </React.Fragment>)}
        {!sorted.length && <tr><td colSpan="3">No matching products. Try another keyword.</td></tr>}
      </tbody></table></div>
      {error && <p role="alert" className="stock-error">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy || !ready || !changed.length}>{busy ? 'Saving…' : 'Save stock'}</button></footer>
    </form>
  </dialog>, document.body);
}

export function StockLine({ item, stock, onEdit }) {
  const row = stock.rows[String(item.id)];
  return <div className="stock-line">
    <span>Stock: <strong>{stock.status === 'loading' ? '…' : stock.status === 'error' ? 'Unavailable' : row?.quantity ?? 'Not set'}</strong></span>
    <button type="button" className="stock-reveal" onClick={onEdit} aria-label={`Update stock for ${item.name}`} title="Update stock">✎</button>
    {row?.updated_at && <span>Last updated {new Date(row.updated_at).toLocaleDateString('en-IN')}</span>}
  </div>;
}
