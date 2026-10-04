export function stockQuantity(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error('Enter a whole stock quantity of zero or more.');
  const quantity = Number(text);
  if (!Number.isSafeInteger(quantity) || quantity > 2147483647) throw new Error('Stock quantity is too large.');
  return quantity;
}
export function sortedStockItems(items) {
  return [...items].sort((a, b) => String(a.category || 'Uncategorized').localeCompare(String(b.category || 'Uncategorized')) || a.name.localeCompare(b.name));
}

export function isTransientStockError(error) {
  return !error?.code && /fetch|network|load fail|abort|timeout|timed out|connection/i.test(error?.message || String(error));
}
