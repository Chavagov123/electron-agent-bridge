'use strict';
// Deterministic content: 600 table rows × 7 elements (row, 4 cells, span, button), 60 nav links and 100
// filter groups (label, checkbox, list of two) ≈ 5000 elements in total.
(function build() {
  const nav = document.querySelector('nav');
  for (let index = 0; index < 60; index++) {
    const link = document.createElement('a');
    link.href = `#section-${index}`;
    link.textContent = `Section ${index}`;
    nav.appendChild(link);
  }
  const rows = document.getElementById('rows');
  for (let index = 0; index < 600; index++) {
    const row = document.createElement('tr');
    row.innerHTML =
      `<td>${index}</td><td><span>Item ${index}</span></td><td>${(index * 7) % 100}.00</td>` +
      `<td><button type="button">Edit ${index}</button></td>`;
    rows.appendChild(row);
  }
  const filters = document.getElementById('filters');
  for (let index = 0; index < 100; index++) {
    filters.insertAdjacentHTML(
      'beforeend',
      `<div><label>Filter ${index} <input type="checkbox"></label><ul><li>a</li><li>b</li></ul></div>`,
    );
  }
})();

let counter = 0;
window.mutate = function mutate(count) {
  const cells = document.querySelectorAll('#rows td:nth-child(3)');
  for (let index = 0; index < count; index++) {
    counter++;
    // Long tables are collapsed to their first 20 rows in snapshots: change cells that are shown.
    const cell = cells[(counter * 7) % 20];
    cell.textContent = `${counter}.50`;
  }
  return count;
};
