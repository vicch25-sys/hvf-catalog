const DEFAULT_TERMS = [
  "This quotation is valid for one month from the date of issue.",
  "Delivery is subject to stock availability and may take up to 2 weeks.",
  "Goods once sold are non-returnable and non-exchangeable.",
].join("\n");

// Measure using the same font, wrapping and leading used to draw each line.
export function measureQuotationFooter(doc, { firm, terms, width, scale = 1 }) {
  const mahabir = firm === "Mahabir Hardware Stores";
  const font = mahabir ? "courier" : "helvetica";
  const blocks = [
    { text: "Terms & Conditions:", bold: true, size: 11, gap: 0 },
    { text: mahabir ? DEFAULT_TERMS : String(terms || DEFAULT_TERMS), size: 10, gap: 16 },
    { text: ["Yours Faithfully", mahabir ? firm : "HVF Agency",
      mahabir ? "—" : "9957239143 / 9954425780",
      mahabir ? "GST: 18ACBPA2363D1Z9" : "GST: 18AFCPC4260P1ZB"].join("\n"), size: 10, gap: 22 },
    { text: "BANK DETAILS", bold: true, size: 10, gap: 26 },
    { text: (mahabir ? ["AC No. 11010061051", "IFSC Cord - SBIN0007368", "Branch - Moran Branch"] : [
      "HVF AGENCY", "ICICI BANK (Moran Branch)", "A/C No - 199505500412",
      "IFSC Code - ICIC0001995", "Email: hvfagency123@gmail.com",
    ]).join("\n"), bold: true, size: 10, gap: 16 },
  ];
  let baseline = 0;
  const lines = [];
  for (const block of blocks) {
    const size = block.size * scale;
    doc.setFont(font, block.bold ? "bold" : "normal");
    doc.setFontSize(size);
    const wrapped = block.text.split(/\r?\n/).flatMap(line =>
      line.trim() ? doc.splitTextToSize(line, width) : [""]);
    baseline += block.gap * scale;
    wrapped.forEach((text, index) => {
      if (index) baseline += 12 * scale;
      lines.push({ text, y: baseline, size, bold: !!block.bold });
    });
  }
  return { font, lines, height: baseline + 3 * scale };
}

export function drawQuotationFooter(doc, footer, { x, y, top, bottom }) {
  let offset = y;
  for (const line of footer.lines) {
    let baseline = offset + line.y;
    if (baseline + line.size * 0.3 > bottom) {
      doc.addPage();
      baseline = top + line.size;
      offset = baseline - line.y;
    }
    doc.setFont(footer.font, line.bold ? "bold" : "normal");
    doc.setFontSize(line.size);
    doc.text(line.text, x, baseline);
  }
}
