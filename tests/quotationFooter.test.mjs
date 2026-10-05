import test from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import { measureQuotationFooter, drawQuotationFooter } from '../src/quotationFooter.js';

test('extra terms and wrapped lines move every subsequent block down', () => {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const measure = terms => measureQuotationFooter(doc, { firm: 'HVF Agency', terms, width: 515 });
  const short = measure('One condition');
  const extra = measure('One condition\nSecond condition\n\n' + 'Long condition '.repeat(30));
  const bank = footer => footer.lines.find(line => line.text === 'BANK DETAILS').y;
  assert.ok(bank(extra) > bank(short) + 36);
  for (const footer of [short, extra]) {
    for (let i = 1; i < footer.lines.length; i++) {
      assert.ok(footer.lines[i].y - footer.lines[i-1].y >= 12);
    }
    assert.ok(footer.height > footer.lines.at(-1).y);
  }
});

test('oversized terms preserve every line and the bottom margin on continuation pages', () => {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const footer = measureQuotationFooter(doc, {
    firm: 'HVF Agency', terms: Array.from({length: 100}, (_,i) => `Condition ${i}`).join('\n'), width: 515, scale: 0.72,
  });
  const drawn = [];
  doc.text = (text, x, y) => drawn.push({ text, y, size: doc.getFontSize() });
  drawQuotationFooter(doc, footer, { x: 40, y: 300, top: 40, bottom: 801.89 });
  assert.ok(doc.getNumberOfPages() > 1);
  assert.deepEqual(drawn.map(line => line.text), footer.lines.map(line => line.text));
  assert.ok(drawn.every(line => line.y >= 40 && line.y + line.size * 0.3 <= 801.89));
});
