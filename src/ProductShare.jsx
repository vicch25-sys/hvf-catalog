import React, { useEffect, useMemo, useState } from 'react';

const formatRupees = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const safeFileName = value => String(value || 'product').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'product';

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

async function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The product image could not be loaded for sharing.'));
    image.src = src;
  });
}

async function createShareImage(product) {
  const width = 1080;
  const imageBox = { x: 64, y: 80, w: 952, h: 630 };
  const image = product.image_url ? await loadImage(product.image_url) : null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot create the share image.');
  ctx.font = '700 44px system-ui, -apple-system, sans-serif';
  const nameLines = wrapText(ctx, product.name || 'Product', 952);
  const specs = String(product.specs || product.description || '').trim();
  ctx.font = '400 30px system-ui, -apple-system, sans-serif';
  const descriptionLines = specs ? wrapText(ctx, specs, 952) : [];
  const nameY = 770;
  const descriptionY = nameY + nameLines.length * 58 + 22;
  const priceTop = descriptionY + descriptionLines.length * 43 + 44;
  const height = Math.max(1170, priceTop + 152);
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#1677ff';
  ctx.fillRect(64, 38, 92, 8);

  if (image) {
    const scale = Math.min(imageBox.w / image.width, imageBox.h / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    ctx.drawImage(image, imageBox.x + (imageBox.w - drawW) / 2, imageBox.y + (imageBox.h - drawH) / 2, drawW, drawH);
  } else {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(imageBox.x, imageBox.y, imageBox.w, imageBox.h);
    ctx.fillStyle = '#64748b';
    ctx.font = '400 26px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Product image unavailable', width / 2, imageBox.y + imageBox.h / 2);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = '#172033';
  ctx.font = '700 44px system-ui, -apple-system, sans-serif';
  nameLines.forEach((line, index) => ctx.fillText(line, 64, nameY + index * 58));
  ctx.fillStyle = '#64748b';
  ctx.font = '400 30px system-ui, -apple-system, sans-serif';
  descriptionLines.forEach((line, index) => ctx.fillText(line, 64, descriptionY + index * 43));
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(64, priceTop);
  ctx.lineTo(width - 64, priceTop);
  ctx.stroke();
  ctx.fillStyle = '#64748b';
  ctx.font = '600 24px system-ui, -apple-system, sans-serif';
  ctx.fillText('MRP', 64, priceTop + 48);
  ctx.fillStyle = '#172033';
  ctx.font = '700 54px system-ui, -apple-system, sans-serif';
  ctx.fillText(formatRupees(product.mrp), 64, priceTop + 112);

  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not finish creating the share image.')), 'image/jpeg', 0.82));
}

export default function ProductShareModal({ product, onClose }) {
  const [blob, setBlob] = useState(null);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    let active = true;
    createShareImage(product).then(file => { if (active) setBlob(file); }).catch(failure => { if (active) setError(failure.message || 'Could not create the share image.'); });
    return () => { active = false; };
  }, [product]);
  const imageUrl = useMemo(() => blob ? URL.createObjectURL(blob) : '', [blob]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);
  const fileName = `${safeFileName(product.name)}.jpg`;

  function saveImage() {
    if (!imageUrl) return;
    const anchor = document.createElement('a');
    anchor.href = imageUrl;
    anchor.download = fileName;
    anchor.click();
  }

  async function shareImage() {
    if (!blob) return;
    setSharing(true);
    try {
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: product.name, text: `${product.name} · MRP ${formatRupees(product.mrp)}` });
      } else {
        setError('This browser cannot attach an image directly to WhatsApp. Save the image, then attach it in WhatsApp.');
      }
    } catch (failure) {
      if (failure?.name !== 'AbortError') setError(failure.message || 'Could not open the share menu. Save the image and attach it in WhatsApp.');
    } finally { setSharing(false); }
  }

  return <div className="product-share-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="product-share-dialog" role="dialog" aria-modal="true" aria-labelledby="product-share-title">
      <header><div><h2 id="product-share-title">Share product</h2><p>{product.name}</p></div><button type="button" aria-label="Close share preview" onClick={onClose}>×</button></header>
      <div className="product-share-preview-wrap">
        {blob ? <img className="product-share-preview" src={imageUrl} alt={`Share card for ${product.name}`} /> : error ? <p role="alert" className="product-share-error">{error}</p> : <p role="status">Creating your image…</p>}
      </div>
      {error && blob && <p role="alert" className="product-share-error">{error}</p>}
      {blob && <p className="product-share-hint">Press and hold the image to save it, or use Save image. Share opens your phone’s share menu; choose WhatsApp there.</p>}
      <footer><button type="button" onClick={onClose}>Close</button><button type="button" disabled={!blob || sharing} onClick={saveImage}>Save image</button><button type="button" className="product-share-primary" disabled={!blob || sharing} onClick={shareImage}>{sharing ? 'Opening share…' : 'Share / WhatsApp'}</button></footer>
    </section>
  </div>;
}
